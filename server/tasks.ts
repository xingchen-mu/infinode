import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { AssetInfo, CustomWorkflow, Task, TaskRequest } from '../shared/types.ts';
import { type AssetStore, type StoredAsset, mimeFor, publicAsset } from './assets.ts';
import { type ComfyClient, type ComfyEvent, INTERRUPTED, historyError, historyFiles } from './comfy.ts';
import { config } from './config.ts';
import { type BuiltWorkflow, type Stage, randomSeed } from './workflows/graph.ts';
import { fixModelPaths } from './workflows/custom.ts';
import { RequestError, buildWorkflow, requestAssets } from './workflows/index.ts';
import { t } from './i18n.ts';

type ObjectInfo = Parameters<typeof fixModelPaths>[1];

interface Tracked {
  task: Task;
  graph?: BuiltWorkflow['graph'];
  outputNodes?: string[];
  /** Node count, for progress when a workflow has no known heavy nodes. */
  nodeCount?: number;
  stages: Stage[];
  /** Stage nodes that have finished. */
  done: Set<string>;
  current?: string;
  currentFrac: number;
  lastEventAt: number;
  finalizing?: boolean;
  /** Set when the submit reply timed out: ComfyUI may or may not have the prompt yet. */
  unconfirmedSince?: number;
}

/** How long to keep looking for a prompt whose submit reply timed out. */
const UNCONFIRMED_GRACE = 5 * 60_000;

const LOADER_TYPES = /Loader|LoadImage|LoadVideo/;

/** ComfyUI exceptions → something a user can act on. */
function friendlyError(raw: string): string {
  const msg = raw.trim();
  if (/out of memory|OutOfMemory|CUDA error: out of memory/i.test(msg)) return t('显存不足：试试降低分辨率或时长，或等其它任务结束后重试');
  if (/fp8e4nv not supported/i.test(msg)) return t('这个模型需要 fp8 计算，当前服务器 GPU 在 triton 后端下不支持');
  if (/Invalid image file|No such file|not found/i.test(msg) && /LoadImage|image/i.test(msg)) return t('输入图片在 ComfyUI 上找不到了，请重试（{detail}）', { detail: msg.slice(0, 120) });
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}
const MAX_KEPT = 400;

const ACTIVE = new Set(['queued', 'running']);

export class TaskManager extends EventEmitter {
  private tracked = new Map<string, Tracked>();
  private byPrompt = new Map<string, string>();
  private readonly file = join(config.dataDir, 'tasks.json');
  private saveTimer?: NodeJS.Timeout;
  private queueTimer?: NodeJS.Timeout;

  constructor(
    private comfy: ComfyClient,
    private assets: AssetStore,
    private getWorkflow: (id: string) => CustomWorkflow | undefined,
    private getObjectInfo: () => ObjectInfo | undefined,
  ) {
    super();
    this.setMaxListeners(100);
  }

  async init() {
    try {
      const tasks = JSON.parse(await readFile(this.file, 'utf8')) as (Task & { stages?: Stage[]; outputNode?: string; outputNodes?: string[] })[];
      for (const job of tasks) {
        const { stages = [], outputNode, outputNodes, ...task } = job;
        this.tracked.set(task.id, {
          task,
          stages,
          outputNodes: outputNodes ?? (outputNode ? [outputNode] : undefined),
          done: new Set(),
          currentFrac: 0,
          lastEventAt: 0,
        });
        if (task.promptId) this.byPrompt.set(task.promptId, task.id);
        else if (ACTIVE.has(task.status)) Object.assign(task, { status: 'error', error: t('提交过程中服务重启了，请重试'), stage: t('失败') });
      }
    } catch {
      /* first run */
    }
    setInterval(() => void this.poll(), 4000);
  }

  list(ids?: string[]): Task[] {
    if (ids) return ids.map((id) => this.tracked.get(id)?.task).filter((job): job is Task => Boolean(job));
    return [...this.tracked.values()].map((job) => job.task);
  }

  active(): Task[] {
    return this.list().filter((job) => ACTIVE.has(job.status));
  }

  /** `id` may be chosen by the client so a placeholder can reference the task before this returns. */
  async create(req: TaskRequest, id?: string): Promise<Task> {
    if (id !== undefined && (!/^[\w-]{6,32}$/.test(id) || this.tracked.has(id))) throw new RequestError(t('任务 id 无效'));
    const seed = Number.isSafeInteger(req.seed) && req.seed! >= 0 ? req.seed! : randomSeed();
    const refs = requestAssets(req);
    const lookup = (kind: 'image' | 'video') => (id: string) => {
      const a = this.assets.get(id);
      if (!a) throw new RequestError(t('引用的素材不存在，可能已被删除'));
      if (a.kind !== kind) throw new RequestError(kind === 'image' ? t('这里只能使用图片') : t('这里只能使用视频'));
      return a;
    };
    const imageAssets = refs.images.map(lookup('image'));
    const videoAssets = refs.videos.map(lookup('video'));
    const maskAsset = refs.mask ? lookup('image')(refs.mask) : undefined;

    // Validate and size the workflow before uploading anything; bad requests fail fast with a 400.
    const pending = (a: StoredAsset) => ({ comfyName: 'pending.png', width: a.width, height: a.height, hasAlpha: a.hasAlpha });
    const draft = buildWorkflow(
      req,
      { images: imageAssets.map(pending), videos: videoAssets.map(pending), mask: maskAsset && pending(maskAsset) },
      seed,
      this.getWorkflow,
    );

    // Register right away so the client can see the task while inputs upload.
    const task: Task = {
      id: id ?? nanoid(10),
      request: req,
      status: 'queued',
      progress: 0,
      stage: imageAssets.length || videoAssets.length ? t('上传素材') : t('提交中'),
      expected: draft.expected,
      results: [],
      seed,
      createdAt: Date.now(),
    };
    const job: Tracked = { task, stages: draft.stages, done: new Set(), currentFrac: 0, lastEventAt: Date.now() };
    this.tracked.set(task.id, job);
    this.prune();
    this.emitTask(job);

    try {
      let promptId: string;
      try {
        promptId = await this.submit(job, req, seed, imageAssets, videoAssets, maskAsset, false);
      } catch (err) {
        // ComfyUI's input folder may have been cleaned: upload again and retry once.
        if (!(err instanceof Error) || !/image|file|video/i.test(err.message) || !(imageAssets.length || videoAssets.length)) throw err;
        promptId = await this.submit(job, req, seed, imageAssets, videoAssets, maskAsset, true);
      }
      task.promptId = promptId;
      job.lastEventAt = Date.now();
      if (!ACTIVE.has(task.status)) {
        // Cancelled while uploading.
        await this.comfy.deleteQueued([promptId]).catch(() => {});
        this.emitTask(job);
      } else if (task.status === 'queued') {
        this.update(job, { stage: t('排队中') });
        this.refreshQueueSoon();
      } else {
        this.emitTask(job);
      }
      return task;
    } catch (err) {
      this.finish(job, { status: 'error', error: friendlyError((err as Error).message), stage: t('失败') });
      throw err;
    }
  }

  private async submit(
    job: Tracked,
    req: TaskRequest,
    seed: number,
    imageAssets: StoredAsset[],
    videoAssets: StoredAsset[],
    maskAsset: StoredAsset | undefined,
    force: boolean,
  ): Promise<string> {
    const upload = async (a: StoredAsset) => ({
      comfyName: await this.ensureUploaded(a, force),
      width: a.width,
      height: a.height,
      hasAlpha: a.hasAlpha,
    });
    const images = await Promise.all(imageAssets.map(upload));
    const videos = await Promise.all(videoAssets.map(upload));
    const mask = maskAsset ? await upload(maskAsset) : undefined;
    const wf = buildWorkflow(req, { images, videos, mask }, seed, this.getWorkflow);
    // Imported workflows name models as their author had them; use what this server has.
    const info = req.op === 'custom' ? this.getObjectInfo() : undefined;
    if (info) fixModelPaths(wf.graph, info);
    job.graph = wf.graph;
    job.outputNodes = wf.outputNodes;
    job.nodeCount = Object.keys(wf.graph).length;
    job.stages = wf.stages;
    // Registered before sending so events that beat the HTTP reply still find the task.
    const promptId = randomUUID();
    this.byPrompt.set(promptId, job.task.id);
    try {
      await this.comfy.queuePrompt(wf.graph, promptId);
    } catch (err) {
      // ComfyUI's HTTP server can stall for a minute while it loads models from a slow disk.
      // A timed-out reply does not mean the prompt was rejected: keep the id and let poll() find out.
      if (/timeout|aborted/i.test((err as Error).message)) {
        job.unconfirmedSince = Date.now();
        this.update(job, { stage: t('已提交，ComfyUI 响应较慢…') });
        return promptId;
      }
      this.byPrompt.delete(promptId);
      throw err;
    }
    return promptId;
  }

  /** Each asset is uploaded once; later tasks reuse the file already in ComfyUI's input folder. */
  private async ensureUploaded(a: StoredAsset, force: boolean): Promise<string> {
    if (a.comfyName && !force) return a.comfyName;
    const name = await this.comfy.upload(await this.assets.read(a), a.file);
    this.assets.setComfyName(a.id, name);
    return name;
  }

  async cancel(id: string): Promise<Task | undefined> {
    const job = this.tracked.get(id);
    if (!job || !ACTIVE.has(job.task.status)) return job?.task;
    if (!job.task.promptId) {
      // Still uploading; create() drops the prompt once it is queued.
      this.finish(job, { status: 'cancelled', stage: t('已取消') });
      return job.task;
    }
    const wasRunning = job.task.status === 'running';
    this.finish(job, { status: 'cancelled', stage: t('已取消') });
    try {
      if (wasRunning) await this.comfy.interrupt(job.task.promptId);
      else await this.comfy.deleteQueued([job.task.promptId]);
    } catch {
      /* the prompt may have finished meanwhile */
    }
    return job.task;
  }

  /** Handles a ComfyUI websocket event. */
  onComfyEvent(e: ComfyEvent) {
    if (e.type === 'status') {
      this.refreshQueueSoon();
      return;
    }
    const promptId = e.data?.prompt_id as string | undefined;
    const job = promptId ? this.tracked.get(this.byPrompt.get(promptId) ?? '') : undefined;
    if (!job || !ACTIVE.has(job.task.status)) return;
    job.lastEventAt = Date.now();
    switch (e.type) {
      case 'execution_start':
        this.update(job, { status: 'running', startedAt: Date.now(), stage: t('准备中'), queuePosition: undefined });
        this.refreshQueueSoon();
        break;
      case 'execution_cached':
        for (const n of (e.data.nodes as string[]) ?? []) job.done.add(String(n));
        this.recompute(job);
        break;
      case 'executing': {
        if (job.current) job.done.add(job.current);
        const node = e.data.node == null ? undefined : String(e.data.node);
        job.current = node;
        job.currentFrac = 0;
        if (node) {
          const stage = job.stages.find((s) => s.node === node);
          const type = job.graph?.[node]?.class_type ?? '';
          const label = stage?.label ?? (LOADER_TYPES.test(type) || /TextEncode/.test(type) ? t('加载模型') : undefined);
          if (job.task.status !== 'running') job.task.status = 'running';
          this.recompute(job, label);
        }
        break;
      }
      case 'progress': {
        const node = String(e.data.node ?? job.current ?? '');
        if (node && node !== job.current) {
          if (job.current) job.done.add(job.current);
          job.current = node;
        }
        const max = Number(e.data.max) || 1;
        job.currentFrac = Math.min(1, Number(e.data.value) / max);
        const stage = job.stages.find((s) => s.node === node);
        this.recompute(job, stage ? `${stage.label} ${Math.round(job.currentFrac * 100)}%` : undefined);
        break;
      }
      case 'execution_success':
        void this.finalize(job);
        break;
      case 'execution_error': {
        const d = e.data as { exception_message?: string; node_type?: string };
        this.finish(job, { status: 'error', error: friendlyError(`${d.node_type ?? ''} ${d.exception_message ?? t('执行失败')}`), stage: t('失败') });
        break;
      }
      case 'execution_interrupted':
        this.finish(job, { status: 'cancelled', stage: t('已中断') });
        break;
    }
  }

  /** Websocket came back: anything may have finished while it was down. */
  onReconnect() {
    void this.poll(true);
  }

  private recompute(job: Tracked, stage?: string) {
    let ratio: number;
    if (job.stages.length) {
      const total = job.stages.reduce((s, x) => s + x.weight, 0) || 1;
      let p = 0;
      for (const s of job.stages) {
        if (job.done.has(s.node)) p += s.weight;
        else if (s.node === job.current) p += s.weight * job.currentFrac;
      }
      ratio = p / total;
    } else {
      // No known heavy nodes: count finished nodes.
      ratio = (job.done.size + job.currentFrac) / Math.max(1, job.nodeCount ?? job.done.size + 1);
    }
    const progress = Math.max(job.task.progress, Math.min(0.99, ratio));
    this.update(job, { progress, ...(stage ? { stage } : {}) });
  }

  private async finalize(job: Tracked) {
    if (job.finalizing || !job.task.promptId) return;
    job.finalizing = true;
    try {
      const entry = await this.comfy.history(job.task.promptId);
      if (!entry) {
        job.finalizing = false;
        return;
      }
      const err = historyError(entry);
      if (err) {
        const interrupted = err === INTERRUPTED;
        this.finish(job, { status: interrupted ? 'cancelled' : 'error', error: interrupted ? t('已中断') : friendlyError(err), stage: interrupted ? t('已中断') : t('失败') });
        return;
      }
      this.update(job, { stage: t('保存结果'), progress: 0.99 });
      // Only files the board can show (skips audio, text, latents…).
      const files = historyFiles(entry, job.outputNodes).filter((f) => mimeFor(f.filename));
      if (!files.length) throw new Error(t('ComfyUI 没有返回可显示的图片或视频，检查工作流的输出节点'));
      const results: AssetInfo[] = [];
      for (const f of files) {
        const data = await this.comfy.view(f);
        const isVideo = mimeFor(f.filename)!.startsWith('video/');
        const asset = await this.assets.save(data, {
          filename: f.filename,
          // Video size is only a guess here; the page measures it on load.
          size: isVideo ? { width: job.task.expected.width, height: job.task.expected.height } : undefined,
          // LoadImage can read ComfyUI's own output folder, so follow-up edits need no upload.
          comfyName: `${f.subfolder ? `${f.subfolder}/` : ''}${f.filename} [${f.type || 'output'}]`,
        });
        results.push(publicAsset(asset));
      }
      this.finish(job, { status: 'done', results, progress: 1, stage: t('完成') });
    } catch (err) {
      this.finish(job, { status: 'error', error: t('获取结果失败: {message}', { message: (err as Error).message }), stage: t('失败') });
    } finally {
      job.finalizing = false;
    }
  }

  private finish(job: Tracked, patch: Partial<Task>) {
    job.graph = undefined;
    this.update(job, { ...patch, finishedAt: Date.now(), queuePosition: undefined });
  }

  private update(job: Tracked, patch: Partial<Task>) {
    Object.assign(job.task, patch);
    this.emitTask(job);
  }

  private emitTask(job: Tracked) {
    this.emit('task', job.task);
    this.scheduleSave();
  }

  /** Fallback for missed websocket events: ask /history about quiet active tasks. */
  private async poll(force = false) {
    const now = Date.now();
    for (const job of this.tracked.values()) {
      if (!ACTIVE.has(job.task.status) || !job.task.promptId || job.finalizing) continue;
      if (!force && now - job.lastEventAt < 8000) continue;
      job.lastEventAt = now;
      try {
        const entry = await this.comfy.history(job.task.promptId);
        if (entry?.status?.completed || entry?.status?.status_str === 'error') {
          await this.finalize(job);
          continue;
        }
        if (!entry) {
          const q = await this.comfy.queue();
          const running = q.queue_running.some((item) => item[1] === job.task.promptId);
          const known = running || q.queue_pending.some((item) => item[1] === job.task.promptId);
          if (known) job.unconfirmedSince = undefined;
          if (!known && job.unconfirmedSince && now - job.unconfirmedSince < UNCONFIRMED_GRACE) continue;
          if (!known) this.finish(job, { status: 'error', error: t('ComfyUI 中找不到这个任务（可能已被清空或重启）'), stage: t('失败') });
          // No events reach us for prompts queued under another client id; at least show it is running.
          else if (running && job.task.status === 'queued') this.update(job, { status: 'running', stage: t('运行中'), queuePosition: undefined, startedAt: Date.now() });
        }
      } catch {
        /* ComfyUI offline; try again later */
      }
    }
  }

  private refreshQueueSoon() {
    clearTimeout(this.queueTimer);
    this.queueTimer = setTimeout(() => void this.refreshQueue(), 250);
  }

  private async refreshQueue() {
    const queued = [...this.tracked.values()].filter((job) => job.task.status === 'queued');
    if (!queued.length) return;
    try {
      const q = await this.comfy.queue();
      const pending = [...q.queue_pending].sort((a, b) => Number(a[0]) - Number(b[0])).map((i) => i[1]);
      const running = q.queue_running.map((i) => i[1]);
      for (const job of queued) {
        const idx = pending.indexOf(job.task.promptId);
        if (running.includes(job.task.promptId)) continue;
        if (idx >= 0) {
          const ahead = idx + running.length;
          if (ahead !== job.task.queuePosition) this.update(job, { queuePosition: ahead, stage: ahead ? t('排队中 · 前面 {ahead} 个', { ahead }) : t('即将开始') });
        }
      }
    } catch {
      /* offline */
    }
  }

  private prune() {
    if (this.tracked.size <= MAX_KEPT) return;
    const old = [...this.tracked.values()]
      .filter((job) => !ACTIVE.has(job.task.status))
      .sort((a, b) => a.task.createdAt - b.task.createdAt);
    for (const job of old.slice(0, this.tracked.size - MAX_KEPT)) {
      this.tracked.delete(job.task.id);
      if (job.task.promptId) this.byPrompt.delete(job.task.promptId);
    }
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 500);
  }

  async flush() {
    clearTimeout(this.saveTimer);
    const data = [...this.tracked.values()].map((job) => ({ ...job.task, stages: job.stages, outputNodes: job.outputNodes }));
    const tmp = this.file + '.tmp';
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, this.file);
  }
}

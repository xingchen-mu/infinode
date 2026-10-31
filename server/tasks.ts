import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { AssetInfo, CustomWorkflow, Task, TaskRequest } from '../shared/types.ts';
import { type AssetStore, type StoredAsset, mimeFor, publicAsset } from './assets.ts';
import { type ComfyClient, type ComfyEvent, historyError, historyFiles } from './comfy.ts';
import { config } from './config.ts';
import { type BuiltWorkflow, type Stage, randomSeed } from './workflows/graph.ts';
import { fixModelPaths } from './workflows/custom.ts';
import { RequestError, buildWorkflow, requestAssets } from './workflows/index.ts';

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
  if (/out of memory|OutOfMemory|CUDA error: out of memory/i.test(msg)) return '显存不足：试试降低分辨率或时长，或等其它任务结束后重试';
  if (/fp8e4nv not supported/i.test(msg)) return '这个模型需要 fp8 计算，当前服务器 GPU 在 triton 后端下不支持';
  if (/Invalid image file|No such file|not found/i.test(msg) && /LoadImage|image/i.test(msg)) return `输入图片在 ComfyUI 上找不到了，请重试（${msg.slice(0, 120)}）`;
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
      for (const t of tasks) {
        const { stages = [], outputNode, outputNodes, ...task } = t;
        this.tracked.set(task.id, {
          task,
          stages,
          outputNodes: outputNodes ?? (outputNode ? [outputNode] : undefined),
          done: new Set(),
          currentFrac: 0,
          lastEventAt: 0,
        });
        if (task.promptId) this.byPrompt.set(task.promptId, task.id);
        else if (ACTIVE.has(task.status)) Object.assign(task, { status: 'error', error: '提交过程中服务重启了，请重试', stage: '失败' });
      }
    } catch {
      /* first run */
    }
    setInterval(() => void this.poll(), 4000);
  }

  list(ids?: string[]): Task[] {
    if (ids) return ids.map((id) => this.tracked.get(id)?.task).filter((t): t is Task => Boolean(t));
    return [...this.tracked.values()].map((t) => t.task);
  }

  active(): Task[] {
    return this.list().filter((t) => ACTIVE.has(t.status));
  }

  /** `id` may be chosen by the client so a placeholder can reference the task before this returns. */
  async create(req: TaskRequest, id?: string): Promise<Task> {
    if (id !== undefined && (!/^[\w-]{6,32}$/.test(id) || this.tracked.has(id))) throw new RequestError('任务 id 无效');
    const seed = Number.isSafeInteger(req.seed) && req.seed! >= 0 ? req.seed! : randomSeed();
    const refs = requestAssets(req);
    const lookup = (kind: 'image' | 'video') => (id: string) => {
      const a = this.assets.get(id);
      if (!a) throw new RequestError('引用的素材不存在，可能已被删除');
      if (a.kind !== kind) throw new RequestError(kind === 'image' ? '这里只能使用图片' : '这里只能使用视频');
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
      stage: imageAssets.length || videoAssets.length ? '上传素材' : '提交中',
      expected: draft.expected,
      results: [],
      seed,
      createdAt: Date.now(),
    };
    const t: Tracked = { task, stages: draft.stages, done: new Set(), currentFrac: 0, lastEventAt: Date.now() };
    this.tracked.set(task.id, t);
    this.prune();
    this.emitTask(t);

    try {
      let promptId: string;
      try {
        promptId = await this.submit(t, req, seed, imageAssets, videoAssets, maskAsset, false);
      } catch (err) {
        // ComfyUI's input folder may have been cleaned: upload again and retry once.
        if (!(err instanceof Error) || !/image|file|video/i.test(err.message) || !(imageAssets.length || videoAssets.length)) throw err;
        promptId = await this.submit(t, req, seed, imageAssets, videoAssets, maskAsset, true);
      }
      task.promptId = promptId;
      t.lastEventAt = Date.now();
      if (!ACTIVE.has(task.status)) {
        // Cancelled while uploading.
        await this.comfy.deleteQueued([promptId]).catch(() => {});
        this.emitTask(t);
      } else if (task.status === 'queued') {
        this.update(t, { stage: '排队中' });
        this.refreshQueueSoon();
      } else {
        this.emitTask(t);
      }
      return task;
    } catch (err) {
      this.finish(t, { status: 'error', error: friendlyError((err as Error).message), stage: '失败' });
      throw err;
    }
  }

  private async submit(
    t: Tracked,
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
    t.graph = wf.graph;
    t.outputNodes = wf.outputNodes;
    t.nodeCount = Object.keys(wf.graph).length;
    t.stages = wf.stages;
    // Registered before sending so events that beat the HTTP reply still find the task.
    const promptId = randomUUID();
    this.byPrompt.set(promptId, t.task.id);
    try {
      await this.comfy.queuePrompt(wf.graph, promptId);
    } catch (err) {
      // ComfyUI's HTTP server can stall for a minute while it loads models from a slow disk.
      // A timed-out reply does not mean the prompt was rejected: keep the id and let poll() find out.
      if (/timeout|aborted/i.test((err as Error).message)) {
        t.unconfirmedSince = Date.now();
        this.update(t, { stage: '已提交，ComfyUI 响应较慢…' });
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
    const t = this.tracked.get(id);
    if (!t || !ACTIVE.has(t.task.status)) return t?.task;
    if (!t.task.promptId) {
      // Still uploading; create() drops the prompt once it is queued.
      this.finish(t, { status: 'cancelled', stage: '已取消' });
      return t.task;
    }
    const wasRunning = t.task.status === 'running';
    this.finish(t, { status: 'cancelled', stage: '已取消' });
    try {
      if (wasRunning) await this.comfy.interrupt(t.task.promptId);
      else await this.comfy.deleteQueued([t.task.promptId]);
    } catch {
      /* the prompt may have finished meanwhile */
    }
    return t.task;
  }

  /** Handles a ComfyUI websocket event. */
  onComfyEvent(e: ComfyEvent) {
    if (e.type === 'status') {
      this.refreshQueueSoon();
      return;
    }
    const promptId = e.data?.prompt_id as string | undefined;
    const t = promptId ? this.tracked.get(this.byPrompt.get(promptId) ?? '') : undefined;
    if (!t || !ACTIVE.has(t.task.status)) return;
    t.lastEventAt = Date.now();
    switch (e.type) {
      case 'execution_start':
        this.update(t, { status: 'running', startedAt: Date.now(), stage: '准备中', queuePosition: undefined });
        this.refreshQueueSoon();
        break;
      case 'execution_cached':
        for (const n of (e.data.nodes as string[]) ?? []) t.done.add(String(n));
        this.recompute(t);
        break;
      case 'executing': {
        if (t.current) t.done.add(t.current);
        const node = e.data.node == null ? undefined : String(e.data.node);
        t.current = node;
        t.currentFrac = 0;
        if (node) {
          const stage = t.stages.find((s) => s.node === node);
          const type = t.graph?.[node]?.class_type ?? '';
          const label = stage?.label ?? (LOADER_TYPES.test(type) || /TextEncode/.test(type) ? '加载模型' : undefined);
          if (t.task.status !== 'running') t.task.status = 'running';
          this.recompute(t, label);
        }
        break;
      }
      case 'progress': {
        const node = String(e.data.node ?? t.current ?? '');
        if (node && node !== t.current) {
          if (t.current) t.done.add(t.current);
          t.current = node;
        }
        const max = Number(e.data.max) || 1;
        t.currentFrac = Math.min(1, Number(e.data.value) / max);
        const stage = t.stages.find((s) => s.node === node);
        this.recompute(t, stage ? `${stage.label} ${Math.round(t.currentFrac * 100)}%` : undefined);
        break;
      }
      case 'execution_success':
        void this.finalize(t);
        break;
      case 'execution_error': {
        const d = e.data as { exception_message?: string; node_type?: string };
        this.finish(t, { status: 'error', error: friendlyError(`${d.node_type ?? ''} ${d.exception_message ?? '执行失败'}`), stage: '失败' });
        break;
      }
      case 'execution_interrupted':
        this.finish(t, { status: 'cancelled', stage: '已中断' });
        break;
    }
  }

  /** Websocket came back: anything may have finished while it was down. */
  onReconnect() {
    void this.poll(true);
  }

  private recompute(t: Tracked, stage?: string) {
    let ratio: number;
    if (t.stages.length) {
      const total = t.stages.reduce((s, x) => s + x.weight, 0) || 1;
      let p = 0;
      for (const s of t.stages) {
        if (t.done.has(s.node)) p += s.weight;
        else if (s.node === t.current) p += s.weight * t.currentFrac;
      }
      ratio = p / total;
    } else {
      // No known heavy nodes: count finished nodes.
      ratio = (t.done.size + t.currentFrac) / Math.max(1, t.nodeCount ?? t.done.size + 1);
    }
    const progress = Math.max(t.task.progress, Math.min(0.99, ratio));
    this.update(t, { progress, ...(stage ? { stage } : {}) });
  }

  private async finalize(t: Tracked) {
    if (t.finalizing || !t.task.promptId) return;
    t.finalizing = true;
    try {
      const entry = await this.comfy.history(t.task.promptId);
      if (!entry) {
        t.finalizing = false;
        return;
      }
      const err = historyError(entry);
      if (err) {
        this.finish(t, { status: err === '已中断' ? 'cancelled' : 'error', error: friendlyError(err), stage: err === '已中断' ? err : '失败' });
        return;
      }
      this.update(t, { stage: '保存结果', progress: 0.99 });
      // Only files the board can show (skips audio, text, latents…).
      const files = historyFiles(entry, t.outputNodes).filter((f) => mimeFor(f.filename));
      if (!files.length) throw new Error('ComfyUI 没有返回可显示的图片或视频，检查工作流的输出节点');
      const results: AssetInfo[] = [];
      for (const f of files) {
        const data = await this.comfy.view(f);
        const isVideo = mimeFor(f.filename)!.startsWith('video/');
        const asset = await this.assets.save(data, {
          filename: f.filename,
          // Video size is only a guess here; the page measures it on load.
          size: isVideo ? { width: t.task.expected.width, height: t.task.expected.height } : undefined,
          // LoadImage can read ComfyUI's own output folder, so follow-up edits need no upload.
          comfyName: `${f.subfolder ? `${f.subfolder}/` : ''}${f.filename} [${f.type || 'output'}]`,
        });
        results.push(publicAsset(asset));
      }
      this.finish(t, { status: 'done', results, progress: 1, stage: '完成' });
    } catch (err) {
      this.finish(t, { status: 'error', error: `获取结果失败: ${(err as Error).message}`, stage: '失败' });
    } finally {
      t.finalizing = false;
    }
  }

  private finish(t: Tracked, patch: Partial<Task>) {
    t.graph = undefined;
    this.update(t, { ...patch, finishedAt: Date.now(), queuePosition: undefined });
  }

  private update(t: Tracked, patch: Partial<Task>) {
    Object.assign(t.task, patch);
    this.emitTask(t);
  }

  private emitTask(t: Tracked) {
    this.emit('task', t.task);
    this.scheduleSave();
  }

  /** Fallback for missed websocket events: ask /history about quiet active tasks. */
  private async poll(force = false) {
    const now = Date.now();
    for (const t of this.tracked.values()) {
      if (!ACTIVE.has(t.task.status) || !t.task.promptId || t.finalizing) continue;
      if (!force && now - t.lastEventAt < 8000) continue;
      t.lastEventAt = now;
      try {
        const entry = await this.comfy.history(t.task.promptId);
        if (entry?.status?.completed || entry?.status?.status_str === 'error') {
          await this.finalize(t);
          continue;
        }
        if (!entry) {
          const q = await this.comfy.queue();
          const running = q.queue_running.some((item) => item[1] === t.task.promptId);
          const known = running || q.queue_pending.some((item) => item[1] === t.task.promptId);
          if (known) t.unconfirmedSince = undefined;
          if (!known && t.unconfirmedSince && now - t.unconfirmedSince < UNCONFIRMED_GRACE) continue;
          if (!known) this.finish(t, { status: 'error', error: 'ComfyUI 中找不到这个任务（可能已被清空或重启）', stage: '失败' });
          // No events reach us for prompts queued under another client id; at least show it is running.
          else if (running && t.task.status === 'queued') this.update(t, { status: 'running', stage: '运行中', queuePosition: undefined, startedAt: Date.now() });
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
    const queued = [...this.tracked.values()].filter((t) => t.task.status === 'queued');
    if (!queued.length) return;
    try {
      const q = await this.comfy.queue();
      const pending = [...q.queue_pending].sort((a, b) => Number(a[0]) - Number(b[0])).map((i) => i[1]);
      const running = q.queue_running.map((i) => i[1]);
      for (const t of queued) {
        const idx = pending.indexOf(t.task.promptId);
        if (running.includes(t.task.promptId)) continue;
        if (idx >= 0) {
          const ahead = idx + running.length;
          if (ahead !== t.task.queuePosition) this.update(t, { queuePosition: ahead, stage: ahead ? `排队中 · 前面 ${ahead} 个` : '即将开始' });
        }
      }
    } catch {
      /* offline */
    }
  }

  private prune() {
    if (this.tracked.size <= MAX_KEPT) return;
    const old = [...this.tracked.values()]
      .filter((t) => !ACTIVE.has(t.task.status))
      .sort((a, b) => a.task.createdAt - b.task.createdAt);
    for (const t of old.slice(0, this.tracked.size - MAX_KEPT)) {
      this.tracked.delete(t.task.id);
      if (t.task.promptId) this.byPrompt.delete(t.task.promptId);
    }
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 500);
  }

  async flush() {
    clearTimeout(this.saveTimer);
    const data = [...this.tracked.values()].map((t) => ({ ...t.task, stages: t.stages, outputNodes: t.outputNodes }));
    const tmp = this.file + '.tmp';
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, this.file);
  }
}

import { existsSync } from 'node:fs';
import { nanoid } from 'nanoid';
import { formatBytes } from '../../shared/media.ts';
import type { ModelDownload, ModelDownloadJob, ModelInstallInfo, ModelInstallMode, ModelInstallPlan } from '../../shared/types.ts';
import type { ComfyClient } from '../comfy/client.ts';
import { serverLang, t } from '../i18n.ts';
import type { SettingsStore } from '../settings.ts';
import { RequestError } from '../workflows/index.ts';
import { safeModelPath } from './catalog.ts';
import { type FolderPaths, folderPaths, joinPath, pickFolder, samplePaths } from './folders.ts';
import { type Runner, downloadRemote, probeRemote, sshRunner, validSshHost } from './remote.ts';
import { type Candidate, MIRROR, OFFICIAL, candidates, endpointOf, hostOf } from './sources.ts';
import { DownloadError, type DownloadResult, type ProbeItem, type ProbeResult, downloadLocal, probeLocal } from './transfer.ts';

interface Target {
  mode: ModelInstallMode;
  host?: string;
  reason?: string;
  folders: FolderPaths | null;
}

interface Job extends ModelDownloadJob {
  url: string;
  controller?: AbortController;
}

export interface InstallerDeps {
  comfy: ComfyClient;
  settings: SettingsStore;
  catalog: () => Map<string, ModelDownload>;
  /** A file landed in ComfyUI's models folders: what ComfyUI can run has changed. */
  installed: () => void;
  emit: (job: ModelDownloadJob) => void;
  sshHost?: string;
  /** How to reach the ComfyUI machine (tests use a local python). */
  runner?: (host: string) => Runner;
}

/** Downloads at a time: big files from one CDN gain little from more. */
const PARALLEL = 2;
const KEEP = 50;
const RETRY_DELAYS = [3_000, 10_000, 30_000, 60_000];

/** Waits, or rejects as soon as the download is cancelled. */
function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const isActive = (j: ModelDownloadJob) => j.status === 'queued' || j.status === 'running';

/** A single-quoted shell word. */
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export class ModelInstaller {
  private jobs = new Map<string, Job>();
  private targetCache?: { at: number; url: string; value: Target };
  /** The endpoint that answered last in 'auto' mode, tried first next time. */
  private preferred?: string;

  constructor(private deps: InstallerDeps) {}

  private get host() {
    const h = this.deps.sshHost?.trim();
    return h && validSshHost(h) ? h : undefined;
  }

  private runner(host: string) {
    return (this.deps.runner ?? sshRunner)(host);
  }

  invalidate() {
    this.targetCache = undefined;
  }

  /** Where files would go, worked out from the model folders ComfyUI reports. */
  async target(force = false): Promise<Target> {
    const url = this.deps.comfy.baseUrl;
    const cached = this.targetCache;
    if (!force && cached && cached.url === url && Date.now() - cached.at < 30_000) return cached.value;
    let folders: FolderPaths | null;
    try {
      folders = await folderPaths(this.deps.comfy);
    } catch {
      return { mode: 'offline', reason: t('ComfyUI 未连接'), folders: null };
    }
    let value: Target;
    if (folders && samplePaths(folders).some((p) => existsSync(p))) value = { mode: 'local', folders };
    else if (this.host && folders) value = { mode: 'ssh', host: this.host, folders };
    else if (this.host) value = { mode: 'manual', reason: t('这个版本的 ComfyUI 不提供模型目录信息，无法自动下载。请更新 ComfyUI，或者在服务器上运行下面的命令。'), folders };
    else value = { mode: 'manual', reason: t('ComfyUI 不在这台电脑上。在 .env 里设置 SSH_HOST（ComfyUI 服务器的 SSH 别名）后可以直接下载到服务器，或者在服务器上运行下面的命令。'), folders };
    this.targetCache = { at: Date.now(), url, value };
    return value;
  }

  jobsList(): ModelDownloadJob[] {
    return [...this.jobs.values()].map((j) => this.view(j)).sort((a, b) => b.createdAt - a.createdAt);
  }

  async info(): Promise<ModelInstallInfo> {
    const target = await this.target();
    const cfg = this.deps.settings.modelConfig();
    return {
      mode: target.mode,
      host: target.host,
      reason: target.reason,
      source: cfg.source,
      endpoint: cfg.endpoint,
      hfTokenConfigured: Boolean(cfg.hfToken),
      jobs: this.jobsList(),
    };
  }

  private lookup(names: unknown): ModelDownload[] {
    if (!Array.isArray(names) || !names.length || names.length > 50) throw new RequestError(t('请选择要下载的模型'));
    const catalog = this.deps.catalog();
    return [...new Set(names.map(String))].map((name) => {
      const m = catalog.get(name);
      if (!m || !safeModelPath(m.directory, m.name)) throw new RequestError(t('不知道去哪里下载 {name}', { name }));
      return m;
    });
  }

  private candidates(url: string): Candidate[] {
    const cfg = this.deps.settings.modelConfig();
    return candidates(url, cfg, serverLang(), this.preferred);
  }

  /** What downloading these files would do: where each goes, how big it is, whether it is already there. */
  async plan(names: unknown): Promise<ModelInstallPlan> {
    const models = this.lookup(names);
    const target = await this.target(true);
    if (target.mode === 'offline') throw new RequestError(t('ComfyUI 未连接'));
    const cfg = this.deps.settings.modelConfig();
    const rows = models.map((m) => {
      const folder = pickFolder(target.folders, m.directory);
      return { model: m, folder, path: folder ? joinPath(folder, m.name) : `models/${m.directory}/${m.name}`, candidates: this.candidates(m.url) };
    });
    const items: ProbeItem[] = rows.map((r) => ({ candidates: r.candidates, folder: r.folder, dest: r.folder ? r.path : undefined }));
    const signal = AbortSignal.timeout(60_000);
    let probe: ProbeResult | undefined;
    let probeError: string | undefined;
    try {
      if (target.mode === 'ssh') probe = await probeRemote(this.runner(target.host!), items, cfg.hfToken, signal);
      else probe = await probeLocal(items, cfg.hfToken, signal, target.mode === 'local');
    } catch (err) {
      probeError = this.describe(err);
    }
    const files: ModelInstallPlan['files'] = rows.map((r, i) => {
      const p = probe?.files[i];
      const used = p?.url ?? r.candidates[0].url;
      return {
        name: r.model.name,
        directory: r.model.directory,
        path: r.path,
        url: used,
        ...(p?.size != null ? { size: p.size } : {}),
        ...(p?.exists ? { exists: true } : {}),
        ...(!r.folder && target.mode !== 'manual' ? { error: t('不知道 {directory} 文件夹在哪', { directory: r.model.directory }) } : {}),
        ...(p?.error ? { error: this.describe(new DownloadError(p.error, p.detail ?? '', { status: p.status })) } : {}),
      };
    });
    let reason = target.reason;
    if (probeError) reason = probeError;
    else if (probe && probe.folderOk === false) reason = t('服务器上找不到 ComfyUI 报告的模型目录，请确认 SSH_HOST 指向运行 ComfyUI 的那台电脑');
    return {
      mode: probeError ? 'manual' : target.mode,
      host: target.host,
      reason,
      files,
      ...(probe?.free != null ? { free: probe.free } : {}),
      commands: this.commands(files, cfg.source === 'auto' ? undefined : cfg.hfToken),
    };
  }

  /** Commands that do the same by hand on the ComfyUI machine. */
  private commands(files: ModelInstallPlan['files'], token: string | undefined): string {
    const auth = token ? ' -H "Authorization: Bearer $HF_TOKEN"' : '';
    return files
      .filter((f) => !f.exists)
      .map((f) => {
        const dir = f.path.slice(0, f.path.length - f.name.length).replace(/[\\/]+$/, '');
        return `mkdir -p ${sh(dir)} && curl -L --fail -C -${auth} -o ${sh(f.path)} ${sh(f.url)}`;
      })
      .join('\n');
  }

  start(names: unknown): ModelDownloadJob[] {
    const models = this.lookup(names);
    const out: ModelDownloadJob[] = [];
    for (const m of models) {
      const running = [...this.jobs.values()].find((j) => isActive(j) && j.name === m.name && j.directory === m.directory);
      if (running) {
        out.push(this.view(running));
        continue;
      }
      const job: Job = { id: nanoid(10), name: m.name, directory: m.directory, url: m.url, status: 'queued', received: 0, createdAt: Date.now() };
      this.jobs.set(job.id, job);
      this.emit(job);
      out.push(this.view(job));
    }
    this.prune();
    this.pump();
    return out;
  }

  cancel(id: string): ModelDownloadJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status === 'queued') this.finish(job, 'cancelled');
    else if (job.status === 'running') job.controller?.abort(new DownloadError('runner', 'cancelled'));
    return this.view(job);
  }

  private pump() {
    const running = [...this.jobs.values()].filter((j) => j.status === 'running').length;
    const next = [...this.jobs.values()].filter((j) => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
    for (const job of next.slice(0, Math.max(0, PARALLEL - running))) void this.run(job);
  }

  private async run(job: Job) {
    job.status = 'running';
    job.controller = new AbortController();
    this.emit(job);
    const signal = job.controller.signal;
    try {
      const target = await this.target();
      if (target.mode !== 'local' && target.mode !== 'ssh') throw new RequestError(target.reason ?? t('无法自动下载'));
      const folder = pickFolder(target.folders, job.directory);
      if (!folder) throw new RequestError(t('不知道 {directory} 文件夹在哪', { directory: job.directory }));
      job.path = joinPath(folder, job.name);
      const token = this.deps.settings.modelConfig().hfToken;
      let sample = { at: Date.now(), bytes: 0 };
      let lastEmit = 0;
      const onProgress = (p: { received: number; total?: number }) => {
        const now = Date.now();
        if (now - sample.at >= 1000) {
          const rate = ((p.received - sample.bytes) * 1000) / (now - sample.at);
          job.speed = job.speed === undefined ? rate : job.speed * 0.6 + rate * 0.4;
          sample = { at: now, bytes: p.received };
        }
        job.received = p.received;
        if (p.total !== undefined) job.total = p.total;
        if (now - lastEmit >= 500) {
          lastEmit = now;
          this.emit(job);
        }
      };
      let result: DownloadResult | undefined;
      for (let attempt = 0; !result; attempt++) {
        const spec = { candidates: this.candidates(job.url), token, folder, dest: job.path };
        sample = { at: Date.now(), bytes: job.received };
        try {
          result = target.mode === 'local' ? await downloadLocal(spec, signal, onProgress) : await downloadRemote(this.runner(target.host!), spec, signal, onProgress);
        } catch (err) {
          // Dropped connections are common on files this big: pick up where the .part file left off.
          const retry = err instanceof DownloadError && err.code === 'network' && !signal.aborted && attempt < (err.extra.partial ? RETRY_DELAYS.length : 1);
          if (!retry) throw err;
          job.speed = undefined;
          this.emit(job);
          await sleep(RETRY_DELAYS[attempt], signal);
        }
      }
      const endpoint = result.url ? endpointOf(result.url) : undefined;
      if (endpoint && (endpoint === OFFICIAL || endpoint === MIRROR)) this.preferred = endpoint;
      job.received = result.size;
      job.total = result.size;
      job.source = result.url ? hostOf(result.url) : undefined;
      if (result.existed) job.existed = true;
      this.finish(job, 'done');
      this.deps.installed();
    } catch (err) {
      if (signal.aborted) this.finish(job, 'cancelled');
      else this.finish(job, 'error', this.describe(err));
    }
  }

  private finish(job: Job, status: 'done' | 'error' | 'cancelled', error?: string) {
    job.status = status;
    job.speed = undefined;
    job.finishedAt = Date.now();
    job.controller = undefined;
    if (error) job.error = error;
    this.emit(job);
    this.pump();
  }

  /** A failure in words the user can act on. */
  describe(err: unknown): string {
    if (err instanceof RequestError) return err.message;
    if (!(err instanceof DownloadError)) return (err as Error)?.message ?? String(err);
    const cfg = this.deps.settings.modelConfig();
    const status = err.extra.status;
    switch (err.code) {
      case 'http':
        if (status === 401 || status === 403) {
          return cfg.hfToken
            ? t('没有下载权限（HTTP {status}）：这是需要申请的模型，请先在 Hugging Face 模型页面同意许可；用镜像时还要在设置里选「hf-mirror」才会带上 token', { status })
            : t('需要登录 Hugging Face 才能下载（HTTP {status}）：先在模型页面同意许可，再在设置里填 Hugging Face token', { status });
        }
        if (status === 404) return t('下载地址不存在（HTTP 404）');
        if (status === 429) return t('下载源限流了（HTTP 429），稍后重试，或在设置里换一个下载源');
        return t('下载失败（HTTP {status}）', { status: status ?? '?' });
      case 'network':
        if (err.extra.partial) return t('网络中断：{detail}。已下载的部分会保留，重试时接着下载', { detail: err.detail });
        if (cfg.source === 'huggingface') return t('连不上 Hugging Face：{detail}。国内网络可以在设置里把下载源换成 hf-mirror 镜像', { detail: err.detail });
        if (cfg.source === 'auto') return t('Hugging Face 和 hf-mirror 都连不上：{detail}', { detail: err.detail });
        return t('连不上下载源：{detail}', { detail: err.detail });
      case 'disk':
        return t('磁盘空间不够：还需要 {need}，只剩 {free}', { need: formatBytes(err.extra.need ?? 0), free: formatBytes(err.extra.free ?? 0) });
      case 'folder':
        return t('模型目录不存在或无法写入：{path}', { path: err.detail });
      default:
        if (err.detail === 'python3 not found') return t('服务器上没有 python3，无法下载');
        return t('无法在 ComfyUI 所在的电脑上运行下载：{detail}', { detail: err.detail });
    }
  }

  private view(job: Job): ModelDownloadJob {
    const { url: _url, controller: _controller, ...rest } = job;
    return { ...rest };
  }

  private emit(job: Job) {
    this.deps.emit(this.view(job));
  }

  private prune() {
    const done = [...this.jobs.values()].filter((j) => !isActive(j)).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    for (const j of done.slice(KEEP)) this.jobs.delete(j.id);
  }
}

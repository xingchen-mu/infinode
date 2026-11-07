import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Candidate } from './sources.ts';

// Downloads written by this process, for a ComfyUI on the same machine. server/models/remote-download.py does the
// same on the ComfyUI machine over SSH; both report through the shapes below.

export type FailCode = 'http' | 'network' | 'disk' | 'folder' | 'runner';

export class DownloadError extends Error {
  constructor(
    readonly code: FailCode,
    readonly detail = '',
    readonly extra: { status?: number; partial?: boolean; need?: number; free?: number } = {},
  ) {
    super(`${code}${extra.status ? ` ${extra.status}` : ''}: ${detail}`);
  }
}

export interface DownloadSpec {
  candidates: Candidate[];
  token?: string;
  /** Folder of the model type (its parent must exist). */
  folder: string;
  /** Final path of the file. */
  dest: string;
}

export interface DownloadResult {
  size: number;
  /** The candidate that served it (absent when the file was already there). */
  url?: string;
  existed?: boolean;
}

export type OnProgress = (p: { received: number; total?: number }) => void;

export interface ProbeItem {
  candidates: Candidate[];
  folder?: string;
  dest?: string;
}

export interface ProbeResult {
  files: { exists?: boolean; size?: number | null; url?: string; error?: FailCode; status?: number; detail?: string }[];
  free?: number | null;
  folderOk?: boolean;
}

const UA = 'infinode-model-download';
/** Until response headers arrive; later the stream may pause this long before it counts as stalled. */
const TIMEOUT = 30_000;
/** Room to leave on the disk after the file is written. */
const MARGIN = 256 * 1024 * 1024;

function linked(signal: AbortSignal | undefined, ms: number) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DownloadError('network', 'timeout')), ms);
  const onAbort = () => ctl.abort(signal!.reason);
  if (signal?.aborted) ctl.abort(signal.reason);
  else signal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctl.signal,
    /** Restarts the timeout (call as data arrives). */
    touch: () => timer.refresh(),
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** GET with redirects followed by hand, so the token only goes to the host it was meant for. */
export async function openUrl(url: string, opts: { token?: string; range?: string; signal: AbortSignal }): Promise<Response> {
  let current = url;
  let token = opts.token;
  for (let hop = 0; hop < 10; hop++) {
    const headers: Record<string, string> = { 'User-Agent': UA };
    if (opts.range) headers.Range = opts.range;
    if (token) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await fetch(current, { headers, redirect: 'manual', signal: opts.signal });
    } catch (err) {
      if (opts.signal.aborted) throw opts.signal.reason instanceof DownloadError ? opts.signal.reason : err;
      throw new DownloadError('network', (err as Error & { cause?: Error }).cause?.message ?? (err as Error).message);
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {});
      const next = new URL(location, current);
      if (next.host !== new URL(current).host) token = undefined;
      current = next.href;
      continue;
    }
    return res;
  }
  throw new DownloadError('network', 'too many redirects');
}

/** Full size from a response to a ranged or plain GET. */
export function totalOf(res: Response, start: number): number | undefined {
  const range = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '');
  if (range) return Number(range[1]);
  const length = res.headers.get('content-length');
  return length && /^\d+$/.test(length.trim()) ? Number(length) + start : undefined;
}

async function size(path: string): Promise<number | undefined> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : undefined;
  } catch {
    return undefined;
  }
}

async function isDir(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function freeSpace(path: string): Promise<number | undefined> {
  let p = path;
  for (;;) {
    try {
      const s = await statfs(p);
      return s.bavail * s.bsize;
    } catch {
      const up = dirname(p);
      if (up === p) return undefined;
      p = up;
    }
  }
}

async function fetchTo(cand: Candidate, token: string | undefined, part: string, dest: string, signal: AbortSignal, onProgress: OnProgress): Promise<DownloadResult> {
  const start = (await size(part)) ?? 0;
  const guard = linked(signal, TIMEOUT);
  let received = 0;
  let base = 0;
  try {
    const res = await openUrl(cand.url, { token: cand.auth ? token : undefined, range: start ? `bytes=${start}-` : undefined, signal: guard.signal });
    if (res.status === 416 && start > 0) {
      await res.body?.cancel().catch(() => {});
      await rename(part, dest);
      return { size: start, url: cand.url };
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw new DownloadError('http', res.statusText, { status: res.status });
    }
    const resumed = res.status === 206 && start > 0;
    base = resumed ? start : 0;
    received = base;
    const total = totalOf(res, base);
    const free = await freeSpace(dirname(dest));
    if (total !== undefined && free !== undefined && free < total - received + MARGIN) {
      await res.body.cancel().catch(() => {});
      throw new DownloadError('disk', '', { need: total - received, free });
    }
    let last = 0;
    const count = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        guard.touch();
        received += chunk.length;
        const now = Date.now();
        if (now - last >= 500) {
          onProgress({ received, total });
          last = now;
        }
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>), count, createWriteStream(part, { flags: resumed ? 'a' : 'w' }));
    if (total !== undefined && received < total) throw new DownloadError('network', 'connection closed early', { partial: true });
    await rename(part, dest);
    onProgress({ received, total });
    return { size: received, url: cand.url };
  } catch (err) {
    if (signal.aborted) throw signal.reason ?? err;
    if (err instanceof DownloadError) {
      if (err.code === 'network' && received > base) throw new DownloadError('network', err.detail, { partial: true });
      throw err;
    }
    const reason = guard.signal.reason;
    if (reason instanceof DownloadError) throw new DownloadError(reason.code, reason.detail, { partial: received > base });
    throw new DownloadError('network', (err as Error).message, { partial: received > base });
  } finally {
    guard.done();
  }
}

/** The error worth showing out of several sources' failures: an HTTP answer says more than a timeout. */
export function bestError(errors: DownloadError[]): DownloadError {
  return errors.find((e) => e.code === 'http') ?? errors.at(-1) ?? new DownloadError('network', 'no source');
}

/** Downloads one file to `dest` (through `dest.part`, resumed when present), trying candidates in order. */
export async function downloadLocal(spec: DownloadSpec, signal: AbortSignal, onProgress: OnProgress): Promise<DownloadResult> {
  const existing = await size(spec.dest);
  if (existing !== undefined) return { size: existing, existed: true };
  if (!(await isDir(dirname(spec.folder.replace(/[\\/]+$/, ''))))) throw new DownloadError('folder', spec.folder);
  try {
    await mkdir(dirname(spec.dest), { recursive: true });
  } catch {
    throw new DownloadError('folder', spec.folder);
  }
  const part = `${spec.dest}.part`;
  const errors: DownloadError[] = [];
  for (const cand of spec.candidates) {
    try {
      return await fetchTo(cand, spec.token, part, spec.dest, signal, onProgress);
    } catch (err) {
      // Once bytes came in, retry this file rather than switching sources halfway.
      if (!(err instanceof DownloadError) || (err.code !== 'http' && err.code !== 'network') || err.extra.partial) throw err;
      errors.push(err);
    }
  }
  throw bestError(errors);
}

/** Size of each file (by a one-byte ranged GET), whether it is already there, and the free space. */
export async function probeLocal(items: ProbeItem[], token: string | undefined, signal: AbortSignal, checkFiles = true): Promise<ProbeResult> {
  const one = async (item: ProbeItem): Promise<ProbeResult['files'][number]> => {
    if (checkFiles && item.dest) {
      const existing = await size(item.dest);
      if (existing !== undefined) return { exists: true, size: existing };
    }
    const errors: DownloadError[] = [];
    for (const cand of item.candidates) {
      const guard = linked(signal, 15_000);
      try {
        const res = await openUrl(cand.url, { token: cand.auth ? token : undefined, range: 'bytes=0-0', signal: guard.signal });
        await res.body?.cancel().catch(() => {});
        if (!res.ok) throw new DownloadError('http', res.statusText, { status: res.status });
        const noRange = res.status === 206 && !res.headers.get('content-range');
        return { size: noRange ? null : (totalOf(res, 0) ?? null), url: cand.url };
      } catch (err) {
        if (signal.aborted) throw err;
        errors.push(err instanceof DownloadError ? err : new DownloadError('network', (err as Error).message));
      } finally {
        guard.done();
      }
    }
    const e = bestError(errors);
    return { error: e.code, status: e.extra.status, detail: e.detail };
  };
  const files: ProbeResult['files'] = [];
  for (let i = 0; i < items.length; i += 4) files.push(...(await Promise.all(items.slice(i, i + 4).map(one))));
  if (!checkFiles) return { files };
  const first = items.find((i) => i.dest);
  const folderOk = (await Promise.all(items.filter((i) => i.folder).map((i) => isDir(dirname(i.folder!.replace(/[\\/]+$/, '')))))).every(Boolean);
  return { files, free: first?.dest ? ((await freeSpace(dirname(first.dest))) ?? null) : null, folderOk };
}

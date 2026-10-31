import type { ApiNode } from './workflows/graph.ts';

export interface ComfyFileRef {
  filename: string;
  subfolder: string;
  type: string;
}

export interface HistoryEntry {
  prompt: unknown[];
  outputs: Record<string, Record<string, unknown>>;
  status?: { status_str?: string; completed?: boolean; messages?: [string, Record<string, unknown>][] };
}

export interface QueueState {
  queue_running: unknown[][];
  queue_pending: unknown[][];
}

export class ComfyError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

type NodeErrors = Record<string, { class_type?: string; errors?: { message?: string; details?: string }[] }>;

/** Turns ComfyUI's validation response into one readable line. */
function describePromptError(body: string): string {
  try {
    const data = JSON.parse(body) as { error?: { message?: string; details?: string }; node_errors?: NodeErrors };
    const parts: string[] = [];
    for (const [id, ne] of Object.entries(data.node_errors ?? {})) {
      for (const e of ne.errors ?? []) parts.push(`#${id} ${ne.class_type ?? ''}: ${e.message ?? ''}${e.details ? ` (${e.details})` : ''}`);
    }
    if (parts.length) return parts.join('; ');
    if (data.error) return `${data.error.message ?? ''}${data.error.details ? `: ${data.error.details}` : ''}`;
  } catch {
    /* not JSON */
  }
  return body.slice(0, 500);
}

export type ComfyEvent = { type: string; data: Record<string, unknown> };

export class ComfyClient {
  private ws?: WebSocket;
  private wsTimer?: NodeJS.Timeout;
  private closed = false;
  online = false;

  /**
   * ComfyUI only sends progress for a prompt to the client id that queued it, so the id
   * must survive restarts for in-flight tasks to keep reporting progress.
   */
  constructor(
    public baseUrl: string,
    readonly clientId: string,
  ) {}

  /** Points the client at another ComfyUI; the websocket reconnects there. */
  setBaseUrl(url: string) {
    if (url === this.baseUrl) return;
    this.baseUrl = url;
    this.ws?.close();
  }

  private url(path: string) {
    return this.baseUrl.replace(/\/$/, '') + path;
  }

  private async request(path: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.url(path), { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new ComfyError(`无法连接 ComfyUI (${this.baseUrl}): ${(err as Error).message}`);
    }
    if (!res.ok) throw new ComfyError(describePromptError(await res.text()), res.status);
    return res;
  }

  async json<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
    return (await this.request(path, init, timeoutMs)).json() as Promise<T>;
  }

  /** Uploads into ComfyUI's input folder; returns the value LoadImage expects. */
  async upload(data: Uint8Array, filename: string, subfolder = 'canva'): Promise<string> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(data)]), filename);
    form.append('subfolder', subfolder);
    form.append('type', 'input');
    form.append('overwrite', 'true');
    // The uplink to the server can be slow (~300 KB/s), so allow large files plenty of time.
    const r = await this.json<{ name: string; subfolder?: string }>('/upload/image', { method: 'POST', body: form }, 300_000);
    return r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
  }

  /** `promptId` must be a lowercase UUID; choosing it up front lets callers track the prompt before the reply. */
  async queuePrompt(graph: Record<string, ApiNode>, promptId: string): Promise<{ prompt_id: string; number: number }> {
    return this.json(
      '/prompt',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: graph, client_id: this.clientId, prompt_id: promptId }),
      },
      120_000,
    );
  }

  /** Whether ComfyUI knows the prompt (queued, running or finished). */
  async hasPrompt(promptId: string): Promise<boolean> {
    const q = await this.queue();
    if ([...q.queue_running, ...q.queue_pending].some((item) => item[1] === promptId)) return true;
    return Boolean(await this.history(promptId));
  }

  async history(promptId: string): Promise<HistoryEntry | undefined> {
    const h = await this.json<Record<string, HistoryEntry>>(`/history/${encodeURIComponent(promptId)}`);
    return h[promptId];
  }

  async view(ref: ComfyFileRef): Promise<Uint8Array> {
    const q = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder ?? '', type: ref.type ?? 'output' });
    const res = await this.request(`/view?${q}`, {}, 300_000);
    return new Uint8Array(await res.arrayBuffer());
  }

  queue(): Promise<QueueState> {
    return this.json('/queue');
  }

  async interrupt(promptId: string) {
    await this.request('/interrupt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt_id: promptId }),
    });
  }

  async deleteQueued(promptIds: string[]) {
    await this.request('/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: promptIds }),
    });
  }

  objectInfo(): Promise<Record<string, { input: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } }>> {
    return this.json('/object_info', {}, 120_000);
  }

  systemStats(): Promise<{ system: { comfyui_version?: string; argv?: string[] }; devices: { name: string }[] }> {
    return this.json('/system_stats', {}, 10_000);
  }

  /** Keeps a websocket open (reconnecting with backoff) and forwards JSON events. */
  connect(onEvent: (e: ComfyEvent) => void, onStatus: (online: boolean) => void) {
    let delay = 1000;
    const open = () => {
      if (this.closed) return;
      const wsUrl = this.url(`/ws?clientId=${this.clientId}`).replace(/^http/, 'ws');
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.onopen = () => {
        delay = 1000;
        this.online = true;
        onStatus(true);
      };
      ws.onmessage = (msg) => {
        if (typeof msg.data !== 'string') return; // binary previews
        try {
          onEvent(JSON.parse(msg.data) as ComfyEvent);
        } catch {
          /* ignore malformed */
        }
      };
      ws.onclose = () => {
        if (this.online) onStatus(false);
        this.online = false;
        if (this.closed) return;
        this.wsTimer = setTimeout(open, delay);
        delay = Math.min(delay * 2, 15_000);
      };
      ws.onerror = () => ws.close();
    };
    open();
  }

  close() {
    this.closed = true;
    clearTimeout(this.wsTimer);
    this.ws?.close();
  }
}

/** Every file the given nodes (default: all) produced, in node order. */
export function historyFiles(entry: HistoryEntry, nodeIds?: string[]): ComfyFileRef[] {
  const files: ComfyFileRef[] = [];
  const nodes = nodeIds?.length ? nodeIds.map((id) => entry.outputs[id]).filter(Boolean) : Object.values(entry.outputs);
  for (const out of nodes) {
    for (const value of Object.values(out)) {
      if (!Array.isArray(value)) continue;
      for (const it of value) {
        if (it && typeof it === 'object' && 'filename' in it) files.push(it as ComfyFileRef);
      }
    }
  }
  return files;
}

export function historyError(entry: HistoryEntry): string | undefined {
  for (const [type, data] of entry.status?.messages ?? []) {
    if (type === 'execution_error') {
      const d = data as { node_type?: string; exception_message?: string };
      return `${d.node_type ?? ''}: ${(d.exception_message ?? '执行失败').trim()}`;
    }
    if (type === 'execution_interrupted') return '已中断';
  }
  return entry.status?.status_str === 'error' ? '执行失败' : undefined;
}

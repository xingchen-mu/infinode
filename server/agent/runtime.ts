import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type ThinkingLevel } from '@earendil-works/pi-agent-core';
import {
  type Api,
  type AssistantMessage,
  type ImageContent,
  type Model,
  type Models,
  type Provider,
  type TSchema,
  type TextContent,
  type ToolResultMessage,
  type UserMessage,
  Type,
  clampThinkingLevel,
  createProvider,
  envApiKeyAuth,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { AgentEntry, AgentEventData, AgentStatus, AgentView, CanvasItem, Task } from '../../shared/types.ts';
import { config } from '../config.ts';
import { RequestError } from '../workflows/index.ts';
import { type CanvasDeps, ResultWriter, describeItem, readBoard } from './board.ts';
import { systemPrompt } from './prompt.ts';
import { type CanvasTool, type Json, type ToolContext, canvasTools } from './tools.ts';

const DEFAULT_MODEL = 'deepseek/deepseek-flash';
const THINKING = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const ID = /^[\w-]{6,32}$/;
/** What the page knew at send time, prepended to the user's words; stripped again for the panel. */
const CONTEXT = /^<canvas_context(?: selection="([^"]*)")?>[\s\S]*?<\/canvas_context>\n*/;
/** Something that happened without the user typing it (tasks finished, an approval); first line is for the panel. */
const EVENT = /^<canvas_event>([\s\S]*)<\/canvas_event>$/;
/** Runs started by finished tasks in a row, before it waits for the user. */
const MAX_AUTO_RUNS = 40;
const IMAGE_DROPPED = '[这张图片已从上下文中移除，需要时用 view_images 重新查看]';
const MAX_MESSAGE = 8000;
/** Selected items described in full in each message; the rest are listed by id. */
const MAX_DESCRIBED = 20;

interface Session {
  projectId: string;
  agent: Agent;
  /** From send() until the run settles; a message arriving meanwhile steers the run. */
  running: boolean;
  /** The current run, including its final save. */
  done?: Promise<void>;
  /** Board point at the center of the user's view when they last sent a message. */
  view?: { x: number; y: number };
  /** Aborted (and replaced) when a message arrives mid-run. */
  interrupt: AbortController;
  /** Streaming text waiting to be pushed (batched, so a fast model does not flood the event stream). */
  textTimer?: NodeJS.Timeout;
  pendingText?: AgentEntry;
  /** Batches the agent asked to hear about when they finish. */
  watches: Watch[];
  /** Runs started by finished tasks since the user last wrote. */
  autoRuns: number;
}

interface Watch {
  what: string;
  items: { id: string; name?: string; taskId: string }[];
}

interface ToolDetails {
  summary?: string;
  items?: string[];
  approval?: { title: string; detail: string; state: 'pending' | 'approved' | 'rejected'; payload: Json };
}

const ACTIVE = new Set(['queued', 'running']);

/** AGENT_BASE_URL: any OpenAI-compatible endpoint (豆包、百炼、Ollama、vLLM…), with AGENT_MODEL naming the model there. */
function customProvider(baseUrl: string, modelId: string): Provider {
  const model: Model<'openai-completions'> = {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'custom',
    baseUrl,
    reasoning: false,
    input: process.env.AGENT_VISION === '1' ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
  return createProvider({
    id: 'custom',
    name: modelId,
    baseUrl,
    auth: { apiKey: envApiKeyAuth('API key', ['AGENT_API_KEY']) },
    models: [model],
    api: openAICompletionsApi(),
  });
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

function textOf(content: string | (TextContent | ImageContent)[]): string {
  return typeof content === 'string' ? content : content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

function hasImage(m: AgentMessage): boolean {
  return (m.role === 'toolResult' || m.role === 'user') && typeof m.content !== 'string' && m.content.some((c) => c.type === 'image');
}

function withoutImages(m: AgentMessage): AgentMessage {
  if (!hasImage(m) || (m.role !== 'toolResult' && m.role !== 'user') || typeof m.content === 'string') return m;
  const content = m.content.map((c): TextContent | ImageContent => (c.type === 'image' ? { type: 'text', text: IMAGE_DROPPED } : c));
  return { ...m, content } as AgentMessage;
}

/** Images cost tokens on every request: keep only the latest batch, and only while the run that looked at it lasts. */
async function latestImagesOnly(messages: AgentMessage[]): Promise<AgentMessage[]> {
  const last = messages.findLastIndex(hasImage);
  if (last < 0) return messages;
  const keep = last > messages.findLastIndex((m) => m.role === 'user' && !hasImage(m)) ? last : -1;
  return messages.map((m, i) => (i === keep ? m : withoutImages(m)));
}

function userEntry(m: UserMessage): AgentEntry {
  const raw = textOf(m.content);
  const event = EVENT.exec(raw.trim());
  if (event) return { kind: 'event', id: `u${m.timestamp}`, text: event[1].trim().split('\n')[0], at: m.timestamp };
  const selection = CONTEXT.exec(raw)?.[1]?.split(',').filter(Boolean) ?? [];
  return { kind: 'user', id: `u${m.timestamp}`, text: raw.replace(CONTEXT, ''), ...(selection.length ? { selection } : {}), at: m.timestamp };
}

function assistantEntry(m: AssistantMessage): AgentEntry | undefined {
  const text = m.content
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('')
    .trim();
  const error = m.stopReason === 'error' ? (m.errorMessage ?? '模型调用失败') : m.stopReason === 'aborted' ? '已停止' : undefined;
  if (!text && !error) return undefined;
  return { kind: 'assistant', id: `a${m.timestamp}`, text, ...(error ? { error } : {}), at: m.timestamp };
}

/** Lets the canvas agent run on any pi-ai model; one conversation per board. */
export class AgentHub {
  readonly status: AgentStatus;
  private readonly dir = join(config.dataDir, 'agent');
  private readonly sessions = new Map<string, Promise<Session>>();
  /** Sessions once open, for task events. */
  private readonly live = new Map<string, Session>();
  private readonly models: Models;
  private readonly model?: Model<Api>;
  private readonly thinking: ThinkingLevel;
  private readonly tools: CanvasTool[];
  private readonly labels: Map<string, CanvasTool>;

  constructor(
    private readonly deps: CanvasDeps,
    private readonly emit: (e: AgentEventData) => void,
    /** For tests: another model collection and "provider/model". */
    opts: { models?: Models; model?: string } = {},
  ) {
    const models = builtinModels();
    let name = opts.model ?? (process.env.AGENT_MODEL?.trim() || DEFAULT_MODEL);
    const baseUrl = process.env.AGENT_BASE_URL?.trim();
    if (baseUrl && !opts.models && process.env.AGENT_MODEL?.trim()) {
      models.setProvider(customProvider(baseUrl, name));
      name = `custom/${name}`;
    }
    this.models = opts.models ?? models;
    const slash = name.indexOf('/');
    this.model = slash > 0 ? this.models.getModel(name.slice(0, slash), name.slice(slash + 1)) : undefined;
    const vision = Boolean(this.model?.input.includes('image'));
    const wanted = (process.env.AGENT_THINKING?.trim() || 'low') as ThinkingLevel;
    this.thinking = !this.model?.reasoning ? 'off' : (clampThinkingLevel(this.model, THINKING.has(wanted) ? wanted : 'low') as ThinkingLevel);
    this.tools = canvasTools(deps, new ResultWriter(deps)).filter((t) => vision || !t.vision);
    this.labels = new Map(this.tools.map((t) => [t.name, t]));
    deps.tasks.on('task', (t: Task) => this.onTask(t));
    this.status = this.model
      ? { ready: false, model: name, vision, reason: '正在检查模型配置' }
      : { ready: false, model: name, vision, reason: `找不到模型 ${name}：AGENT_MODEL 的格式是 provider/model，比如 ${DEFAULT_MODEL}` };
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    if (!this.model) return;
    const auth = await this.models.checkAuth(this.model.provider).catch(() => undefined);
    const env = this.model.provider === 'custom' ? 'AGENT_API_KEY' : `${this.model.provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
    Object.assign(
      this.status,
      auth
        ? { ready: true, reason: undefined }
        : { ready: false, reason: `还没有配置 ${this.model.provider} 的 API key：在项目根目录的 .env 里加一行 ${env}=你的key，然后重启服务` },
    );
  }

  async view(projectId: string): Promise<AgentView> {
    const s = await this.session(projectId);
    return { entries: this.entries(s), running: s.running };
  }

  /** Starts a run, or steers the one in progress. Returns once the message is accepted. */
  async send(projectId: string, input: { text?: string; selection?: string[]; view?: { x: number; y: number } }) {
    if (!this.status.ready) throw new RequestError(this.status.reason ?? '画布助手还没有配置好');
    const text = input.text?.trim();
    if (!text) throw new RequestError('请输入内容');
    const s = await this.session(projectId);
    s.autoRuns = 0;
    const { view } = input;
    if (view && Number.isFinite(view.x) && Number.isFinite(view.y)) s.view = { x: view.x, y: view.y };
    const message: UserMessage = {
      role: 'user',
      content: (await this.boardContext(projectId, input.selection ?? [])) + text.slice(0, MAX_MESSAGE),
      timestamp: Date.now(),
    };
    this.emit({ projectId, entry: userEntry(message) });
    if (s.running) {
      s.agent.steer(message);
      s.interrupt.abort();
      s.interrupt = new AbortController();
      return;
    }
    s.running = true;
    this.emit({ projectId, running: true });
    s.done = this.run(s, message);
  }

  async abort(projectId: string) {
    const s = await this.sessions.get(projectId);
    if (!s) return;
    s.agent.clearAllQueues();
    s.agent.abort();
    if (s.watches.length) {
      s.watches = [];
      this.event(s, '已停止：已提交的任务会继续跑，跑完后助手不会再自动接着做');
    }
  }

  /** The user's answer to work a tool held for approval. */
  async approve(projectId: string, id: string, ok: boolean) {
    const s = await this.session(projectId);
    const result = s.agent.state.messages.find((m) => m.role === 'toolResult' && m.toolCallId === id) as ToolResultMessage | undefined;
    const details = result?.details as ToolDetails | undefined;
    const approval = details?.approval;
    if (!result || !details || !approval) throw new RequestError('找不到这个确认请求');
    if (approval.state !== 'pending') throw new RequestError('这个请求已经处理过了');
    const tool = this.labels.get(result.toolName);
    const show = () => this.emit({ projectId, entry: this.resultEntry(id, result.toolName, result, Date.now()) });
    if (!ok) {
      approval.state = 'rejected';
      details.summary = '没有确认';
      show();
      await this.save(s);
      this.wake(s, `用户没有确认「${approval.title}」，什么都没提交。\n先别生成，问问用户想怎么调整。`);
      return;
    }
    if (!tool?.approve) throw new RequestError('这个请求已经不能执行了');
    approval.state = 'approved';
    details.summary = '已确认，正在提交…';
    show();
    try {
      const out = await tool.approve(approval.payload, this.context(s));
      details.summary = out.summary;
      if (out.items?.length) details.items = out.items;
    } catch (err) {
      // Left pending so the user can try again (e.g. once ComfyUI is back).
      approval.state = 'pending';
      details.summary = `提交失败：${(err as Error).message}`;
      throw err;
    } finally {
      show();
      await this.save(s);
    }
  }

  async clear(projectId: string) {
    const s = await this.session(projectId);
    s.watches = [];
    s.agent.clearAllQueues();
    s.agent.abort();
    // After the run's own save, which would otherwise write the old conversation back.
    await s.done;
    s.agent.reset();
    await rm(this.file(projectId), { force: true });
    this.emit({ projectId, reset: true });
  }

  /** The board was deleted. */
  async forget(projectId: string) {
    if (!ID.test(projectId)) return;
    const s = await this.sessions.get(projectId)?.catch(() => undefined);
    s?.agent.abort();
    this.sessions.delete(projectId);
    this.live.delete(projectId);
    await rm(this.file(projectId), { force: true });
  }

  private file(projectId: string) {
    return join(this.dir, `${projectId}.json`);
  }

  private session(projectId: string): Promise<Session> {
    let s = this.sessions.get(projectId);
    if (!s) {
      s = this.open(projectId);
      this.sessions.set(projectId, s);
      s.catch(() => this.sessions.delete(projectId));
    }
    return s;
  }

  private async open(projectId: string): Promise<Session> {
    if (!ID.test(projectId) || !(await this.deps.projects.get(projectId))) throw new RequestError('画布不存在');
    if (!this.model) throw new RequestError(this.status.reason ?? '画布助手还没有配置好');
    let messages: AgentMessage[] = [];
    try {
      messages = (JSON.parse(await readFile(this.file(projectId), 'utf8')) as { messages: AgentMessage[] }).messages ?? [];
    } catch {
      /* new conversation */
    }
    const s = { projectId, running: false, interrupt: new AbortController(), watches: [], autoRuns: 0 } as unknown as Session;
    s.agent = new Agent({
      initialState: {
        systemPrompt: systemPrompt(this.status.vision),
        model: this.model,
        thinkingLevel: this.thinking,
        tools: this.tools.map((t) => this.agentTool(t, s)),
        messages,
      },
      streamFn: (model, context, options) => this.models.streamSimple(model, context, options),
      transformContext: latestImagesOnly,
      // One at a time: calls place items on the board and queue GPU work in order.
      toolExecution: 'sequential',
      identity: { attribution: null },
      sessionId: projectId,
    });
    s.agent.subscribe((e) => this.onEvent(s, e));
    this.live.set(projectId, s);
    return s;
  }

  /** What a tool call can reach: the board, the user's view, progress and finish notices. */
  private context(s: Session, extra: Partial<ToolContext> = {}): ToolContext {
    return {
      projectId: s.projectId,
      view: s.view,
      interrupt: s.interrupt.signal,
      notify: (what, items) => this.watch(s, what, items),
      seen: (ids) => this.unwatch(s, ids),
      ...extra,
    };
  }

  private watch(s: Session, what: string, items: CanvasItem[]) {
    const tracked = items.filter((i) => i.taskId).map((i) => ({ id: i.id, name: i.name, taskId: i.taskId! }));
    if (tracked.length) s.watches.push({ what, items: tracked });
  }

  private unwatch(s: Session, ids: string[]) {
    const known = new Set(ids);
    s.watches = s.watches.map((w) => ({ ...w, items: w.items.filter((i) => !known.has(i.id)) })).filter((w) => w.items.length);
  }

  private onTask(t: Task) {
    if (ACTIVE.has(t.status)) return;
    // A wait_for_items call sees the same event and marks its items as seen; let it go first.
    setTimeout(() => this.checkWatches(t), 500);
  }

  private checkWatches(t: Task) {
    for (const s of this.live.values()) {
      for (const w of s.watches) {
        if (!w.items.some((i) => i.taskId === t.id)) continue;
        const tasks = this.deps.tasks.list(w.items.map((i) => i.taskId));
        if (tasks.some((x) => ACTIVE.has(x.status))) continue;
        s.watches = s.watches.filter((x) => x !== w);
        this.finished(s, w, tasks);
      }
    }
  }

  /** A watched batch is over: tell the agent what came out, so it carries on. */
  private finished(s: Session, w: Watch, tasks: Task[]) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const label = (i: Watch['items'][number]) => `${i.name ? `${i.name} ` : ''}\`${i.id}\``;
    const ok = w.items.filter((i) => byId.get(i.taskId)?.status === 'done');
    const bad = w.items.filter((i) => byId.get(i.taskId)?.status !== 'done');
    const lines = [
      `${w.what}都结束了：${ok.length} 个完成${bad.length ? `，${bad.length} 个失败或取消` : ''}。`,
      ...bad.map((i) => {
        const t = byId.get(i.taskId);
        return `- ${label(i)}：${t ? (t.status === 'cancelled' ? '已取消' : (t.error ?? '失败')) : '任务记录丢失'}`;
      }),
      ok.length ? `完成的节点：${ok.map(label).join('，')}` : '',
      '接着做下一步；需要用户决定的事就停下来问。',
    ];
    this.wake(s, lines.filter(Boolean).join('\n'));
  }

  /** Starts (or queues) a run on something the user did not type. */
  private wake(s: Session, text: string) {
    if (++s.autoRuns > MAX_AUTO_RUNS) {
      this.event(s, '自动继续的次数到上限了，先停在这里；说一句「继续」让助手接着做');
      return;
    }
    const message: UserMessage = { role: 'user', content: `<canvas_event>${text}</canvas_event>`, timestamp: Date.now() };
    this.emit({ projectId: s.projectId, entry: userEntry(message) });
    if (s.running) {
      s.agent.followUp(message);
      return;
    }
    s.running = true;
    this.emit({ projectId: s.projectId, running: true });
    s.done = this.run(s, message);
  }

  /** A line in the panel only (not sent to the model). */
  private event(s: Session, text: string) {
    this.emit({ projectId: s.projectId, entry: { kind: 'event', id: `n${Date.now()}`, text, at: Date.now() } });
  }

  private agentTool(t: CanvasTool, s: Session): AgentTool<TSchema, ToolDetails> {
    return {
      name: t.name,
      label: t.label,
      description: t.description,
      parameters: Type.Unsafe(t.parameters as unknown as TSchema),
      execute: async (_id, args, signal, onUpdate) => {
        const out = await t.run(
          args as Record<string, unknown>,
          this.context(s, { signal, progress: (text) => onUpdate?.({ content: [{ type: 'text', text }], details: { summary: text } }) }),
        );
        return {
          content: [{ type: 'text', text: out.text }, ...(out.images ?? []).map((img): ImageContent => ({ type: 'image', ...img }))],
          details: {
            summary: out.summary,
            ...(out.items?.length ? { items: out.items } : {}),
            ...(out.approval ? { approval: { ...out.approval, state: 'pending' as const } } : {}),
          },
        };
      },
    };
  }

  /** Board summary and the selected items, as the model sees them. */
  private async boardContext(projectId: string, selection: string[]): Promise<string> {
    const p = await readBoard(this.deps, projectId);
    const selected = selection.map((id) => p.items.find((i) => i.id === id)).filter((i) => i !== undefined);
    const lines = [`画布「${p.name}」，共 ${p.items.length} 个节点。`];
    if (selected.length) {
      lines.push(`用户选中了 ${selected.length} 个节点：`, ...selected.slice(0, MAX_DESCRIBED).map((i) => `- ${describeItem(this.deps, i, 300)}`));
      const rest = selected.slice(MAX_DESCRIBED);
      if (rest.length) lines.push(`- 另有 ${rest.length} 个：${rest.map((i) => `\`${i.id}\``).join(' ')}（详情用 read_board 查看）`);
    } else {
      lines.push('用户没有选中节点。');
    }
    return `<canvas_context selection="${selected.map((i) => i.id).join(',')}">\n${lines.join('\n')}\n</canvas_context>\n\n`;
  }

  private async run(s: Session, first: UserMessage) {
    try {
      let next: AgentMessage[] = [first];
      while (next.length) {
        await s.agent.prompt(next);
        // Messages that arrived as the last turn was ending start the next run.
        next = s.agent.peekQueuedMessages();
        s.agent.clearAllQueues();
      }
    } catch (err) {
      console.error('agent run failed', err);
      this.emit({ projectId: s.projectId, entry: { kind: 'assistant', id: `e${Date.now()}`, text: '', error: (err as Error).message, at: Date.now() } });
    } finally {
      s.running = false;
      await this.save(s).catch((err) => console.error('agent: could not save the conversation', err));
      this.emit({ projectId: s.projectId, running: false });
    }
  }

  private async save(s: Session) {
    const messages = s.agent.state.messages.filter((m) => m.role !== 'system').map(withoutImages);
    const file = this.file(s.projectId);
    await writeFile(`${file}.tmp`, JSON.stringify({ version: 1, messages }));
    await rename(`${file}.tmp`, file);
  }

  /** A finished tool call as the panel shows it (also used while it still runs: `result` undefined). */
  private resultEntry(
    id: string,
    tool: string,
    result: { isError: boolean; content: (TextContent | ImageContent)[]; details?: unknown } | undefined,
    at: number,
    running = false,
    args?: unknown,
  ): AgentEntry {
    const t = this.labels.get(tool);
    const details = (result?.details ?? {}) as ToolDetails;
    const approval = details.approval;
    const base = { kind: 'tool' as const, id, tool, label: t?.label ?? tool, at, ...(details.items?.length ? { items: details.items } : {}) };
    if (!result) return { ...base, status: running ? 'running' : 'error', summary: running ? (t?.describe(args as Record<string, unknown>) ?? '') : '没有完成' };
    if (result.isError) return { ...base, status: 'error', summary: clip(textOf(result.content), 300) };
    if (approval?.state === 'pending') return { ...base, status: 'waiting', summary: details.summary ?? '', approval: { title: approval.title, detail: approval.detail } };
    return { ...base, status: approval?.state === 'rejected' ? 'error' : 'done', summary: details.summary ?? '' };
  }

  /** The panel's view of the transcript. */
  private entries(s: Session): AgentEntry[] {
    const { messages, streamingMessage, pendingToolCalls } = s.agent.state;
    const all = streamingMessage ? [...messages, streamingMessage] : messages;
    const results = new Map<string, ToolResultMessage>();
    for (const m of all) if (m.role === 'toolResult') results.set(m.toolCallId, m as ToolResultMessage);
    const out: AgentEntry[] = [];
    for (const m of all) {
      if (m.role === 'user') out.push(userEntry(m));
      if (m.role !== 'assistant') continue;
      const text = assistantEntry(m);
      if (text) out.push(text);
      for (const c of m.content) {
        if (c.type === 'toolCall') out.push(this.resultEntry(c.id, c.name, results.get(c.id), m.timestamp, m === streamingMessage || pendingToolCalls.has(c.id), c.arguments));
      }
    }
    return out;
  }

  private pushText(s: Session, entry: AgentEntry | undefined, now = false) {
    if (now) {
      clearTimeout(s.textTimer);
      s.textTimer = undefined;
      s.pendingText = undefined;
      if (entry) this.emit({ projectId: s.projectId, entry });
      return;
    }
    if (!entry) return;
    s.pendingText = entry;
    s.textTimer ??= setTimeout(() => {
      s.textTimer = undefined;
      if (s.pendingText) this.emit({ projectId: s.projectId, entry: s.pendingText });
      s.pendingText = undefined;
    }, 80);
  }

  private onEvent(s: Session, e: AgentEvent) {
    const emit = (entry: AgentEntry) => this.emit({ projectId: s.projectId, entry });
    switch (e.type) {
      case 'message_start':
        if (e.message.role === 'user') emit(userEntry(e.message));
        break;
      case 'message_update':
        if (e.message.role === 'assistant') this.pushText(s, assistantEntry(e.message));
        break;
      case 'message_end':
        if (e.message.role === 'assistant') this.pushText(s, assistantEntry(e.message), true);
        break;
      case 'tool_execution_start': {
        const t = this.labels.get(e.toolName);
        emit({ kind: 'tool', id: e.toolCallId, tool: e.toolName, label: t?.label ?? e.toolName, status: 'running', summary: t?.describe(e.args) ?? '', at: Date.now() });
        break;
      }
      case 'tool_execution_update': {
        const t = this.labels.get(e.toolName);
        const summary = (e.partialResult?.details as ToolDetails | undefined)?.summary ?? '';
        emit({ kind: 'tool', id: e.toolCallId, tool: e.toolName, label: t?.label ?? e.toolName, status: 'running', summary, at: Date.now() });
        break;
      }
      case 'tool_execution_end':
        emit(this.resultEntry(e.toolCallId, e.toolName, { isError: e.isError, content: e.result?.content ?? [], details: e.result?.details }, Date.now()));
        break;
    }
  }
}

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
  type ToolCall,
  type ToolResultMessage,
  type UserMessage,
  Type,
  clampThinkingLevel,
  createProvider,
  envApiKeyAuth,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { AgentEntry, AgentEventData, AgentStatus, AgentView } from '../../shared/types.ts';
import { config } from '../config.ts';
import { RequestError } from '../workflows/index.ts';
import { type CanvasDeps, ResultWriter, describeItem, readBoard } from './board.ts';
import { systemPrompt } from './prompt.ts';
import { type CanvasTool, canvasTools } from './tools.ts';

const DEFAULT_MODEL = 'deepseek/deepseek-flash';
const THINKING = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const ID = /^[\w-]{6,32}$/;
/** What the page knew at send time, prepended to the user's words; stripped again for the panel. */
const CONTEXT = /^<canvas_context(?: selection="([^"]*)")?>[\s\S]*?<\/canvas_context>\n*/;
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
}

interface ToolDetails {
  summary?: string;
  items?: string[];
}

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
    const { view } = input;
    if (view && Number.isFinite(view.x) && Number.isFinite(view.y)) s.view = { x: view.x, y: view.y };
    const message: UserMessage = {
      role: 'user',
      content: (await this.context(projectId, input.selection ?? [])) + text.slice(0, MAX_MESSAGE),
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
  }

  async clear(projectId: string) {
    const s = await this.session(projectId);
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
    const s = { projectId, running: false, interrupt: new AbortController() } as Session;
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
    return s;
  }

  private agentTool(t: CanvasTool, s: Session): AgentTool<TSchema, ToolDetails> {
    return {
      name: t.name,
      label: t.label,
      description: t.description,
      parameters: Type.Unsafe(t.parameters as unknown as TSchema),
      execute: async (_id, args, signal, onUpdate) => {
        const out = await t.run(args as Record<string, unknown>, {
          projectId: s.projectId,
          view: s.view,
          signal,
          interrupt: s.interrupt.signal,
          progress: (text) => onUpdate?.({ content: [{ type: 'text', text }], details: { summary: text } }),
        });
        return {
          content: [{ type: 'text', text: out.text }, ...(out.images ?? []).map((img): ImageContent => ({ type: 'image', ...img }))],
          details: { summary: out.summary, ...(out.items?.length ? { items: out.items } : {}) },
        };
      },
    };
  }

  /** Board summary and the selected items, as the model sees them. */
  private async context(projectId: string, selection: string[]): Promise<string> {
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

  private toolEntry(call: ToolCall, result: ToolResultMessage<ToolDetails> | undefined, running: boolean, at: number): AgentEntry {
    const t = this.labels.get(call.name);
    const details = result?.details ?? {};
    const summary = result
      ? result.isError
        ? clip(textOf(result.content), 300)
        : (details.summary ?? '')
      : running
        ? (t?.describe(call.arguments) ?? '')
        : '没有完成';
    return {
      kind: 'tool',
      id: call.id,
      tool: call.name,
      label: t?.label ?? call.name,
      status: result ? (result.isError ? 'error' : 'done') : running ? 'running' : 'error',
      summary,
      ...(details.items?.length ? { items: details.items } : {}),
      at,
    };
  }

  /** The panel's view of the transcript. */
  private entries(s: Session): AgentEntry[] {
    const { messages, streamingMessage, pendingToolCalls } = s.agent.state;
    const all = streamingMessage ? [...messages, streamingMessage] : messages;
    const results = new Map<string, ToolResultMessage<ToolDetails>>();
    for (const m of all) if (m.role === 'toolResult') results.set(m.toolCallId, m as ToolResultMessage<ToolDetails>);
    const out: AgentEntry[] = [];
    for (const m of all) {
      if (m.role === 'user') out.push(userEntry(m));
      if (m.role !== 'assistant') continue;
      const text = assistantEntry(m);
      if (text) out.push(text);
      for (const c of m.content) {
        if (c.type === 'toolCall') out.push(this.toolEntry(c, results.get(c.id), m === streamingMessage || pendingToolCalls.has(c.id), m.timestamp));
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
      case 'tool_execution_end': {
        const t = this.labels.get(e.toolName);
        const details = (e.result?.details ?? {}) as ToolDetails;
        const summary = e.isError ? clip(textOf(e.result?.content ?? []), 300) : (details.summary ?? '');
        emit({
          kind: 'tool',
          id: e.toolCallId,
          tool: e.toolName,
          label: t?.label ?? e.toolName,
          status: e.isError ? 'error' : 'done',
          summary,
          ...(details.items?.length ? { items: details.items } : {}),
          at: Date.now(),
        });
        break;
      }
    }
  }
}

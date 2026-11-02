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
import type { AgentEntry, AgentEventData, AgentStatus, AgentUsage, AgentView, CanvasItem, Task } from '../../shared/types.ts';
import { type Lang, type Vars, msg } from '../../shared/i18n.ts';
import { config } from '../config.ts';
import { serverLang, t } from '../i18n.ts';
import { RequestError } from '../workflows/index.ts';
import { type CanvasDeps, ResultWriter, describeItem, readBoard } from './board.ts';
import { SUMMARY_PROMPT, commercialRules, languageRule, systemPrompt } from './prompt.ts';
import { type CanvasTool, type Json, type ToolContext, canvasTools } from './tools.ts';

const DEFAULT_MODEL = 'deepseek/deepseek-flash';
const THINKING = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const ID = /^[\w-]{6,32}$/;
/** What the page knew at send time, prepended to the user's words; stripped again for the panel. */
const CONTEXT = /^<canvas_context(?: selection="([^"]*)")?>[\s\S]*?<\/canvas_context>\n*/;
/** Something that happened without the user typing it (tasks finished, an approval); first line is for the panel. */
const EVENT = /^<canvas_event>([\s\S]*)<\/canvas_event>$/;
/** The condensed early part of a long conversation. */
const SUMMARY = /^<canvas_summary>[\s\S]*<\/canvas_summary>$/;
/** User turns (typed or events) kept word for word when a long conversation is condensed. */
const KEEP_TURNS = 4;
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
  /** Tokens and estimated cost so far. */
  usage: AgentUsage;
  /** Panel rows of the part of the conversation that was condensed into a summary. */
  archived: AgentEntry[];
  /** Runs started by finished tasks since the user last wrote. */
  autoRuns: number;
  /** The commercial-only setting the model was last told about. */
  commercial: boolean;
  /** The interface language the model was last told to answer in. */
  lang: Lang;
}

/** A batch the agent asked to hear about when it finishes (kept on disk, so a restart does not lose it). */
interface Watch {
  projectId: string;
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

function usageOf(messages: AgentMessage[]): AgentUsage {
  const usage = { tokens: 0, cost: 0 };
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    usage.tokens += m.usage?.totalTokens ?? 0;
    usage.cost += m.usage?.cost?.total ?? 0;
  }
  return usage;
}

/** The early conversation as plain text for the summary (long parts clipped). */
function transcriptText(messages: AgentMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') lines.push(`【用户】${clip(textOf(m.content), 2000)}`);
    else if (m.role === 'toolResult') lines.push(`【结果】${clip(textOf(m.content), 800)}`);
    else if (m.role === 'assistant') {
      for (const c of m.content) {
        if (c.type === 'text' && c.text.trim()) lines.push(`【助手】${clip(c.text.trim(), 2000)}`);
        if (c.type === 'toolCall') lines.push(`【调用 ${c.name}】${clip(JSON.stringify(c.arguments), 600)}`);
      }
    }
  }
  return clip(lines.join('\n'), 120_000);
}

function userEntry(m: UserMessage): AgentEntry {
  const raw = textOf(m.content);
  const event = EVENT.exec(raw.trim());
  if (event) return { kind: 'event', id: `u${m.timestamp}`, text: event[1].trim().split('\n')[0], at: m.timestamp };
  if (SUMMARY.test(raw.trim())) return { kind: 'event', id: `u${m.timestamp}`, text: t('较早的对话已整理成摘要，助手按摘要继续'), at: m.timestamp };
  const selection = CONTEXT.exec(raw)?.[1]?.split(',').filter(Boolean) ?? [];
  return { kind: 'user', id: `u${m.timestamp}`, text: raw.replace(CONTEXT, ''), ...(selection.length ? { selection } : {}), at: m.timestamp };
}

function assistantEntry(m: AssistantMessage): AgentEntry | undefined {
  const text = m.content
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('')
    .trim();
  const error = m.stopReason === 'error' ? (m.errorMessage ?? t('模型调用失败')) : m.stopReason === 'aborted' ? t('已停止') : undefined;
  if (!text && !error) return undefined;
  return { kind: 'assistant', id: `a${m.timestamp}`, text, ...(error ? { error } : {}), at: m.timestamp };
}

/** Lets the canvas agent run on any pi-ai model; one conversation per board. */
export class AgentHub {
  private state: Omit<AgentStatus, 'reason'> & { issue?: [string, Vars?] };

  /** Whether the assistant can run, with the reason in the server's current language. */
  get status(): AgentStatus {
    const { issue, ...rest } = this.state;
    return { ...rest, ...(issue ? { reason: t(issue[0], issue[1]) } : {}) };
  }
  private readonly dir = join(config.dataDir, 'agent');
  private readonly sessions = new Map<string, Promise<Session>>();
  /** Sessions once open. */
  private readonly live = new Map<string, Session>();
  private watches: Watch[] = [];
  private readonly watchFile: string;
  /** Context size (tokens of the last request) at which the early conversation is condensed. */
  private readonly compactAt: number;
  private readonly models: Models;
  private readonly model?: Model<Api>;
  private readonly thinking: ThinkingLevel;
  private readonly tools: CanvasTool[];
  private readonly labels: Map<string, CanvasTool>;

  constructor(
    private readonly deps: CanvasDeps,
    private readonly emit: (e: AgentEventData) => void,
    /** For tests: another model collection and "provider/model", and when to condense. */
    opts: { models?: Models; model?: string; compactAt?: number } = {},
  ) {
    this.watchFile = join(this.dir, 'watches.json');
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
    this.compactAt = opts.compactAt ?? Math.min(100_000, Math.floor((this.model?.contextWindow ?? 128_000) / 2));
    deps.tasks.on('task', (t: Task) => this.onTask(t));
    this.state = this.model
      ? { ready: false, model: name, vision, issue: [msg('正在检查模型配置')] }
      : { ready: false, model: name, vision, issue: [msg('找不到模型 {name}：AGENT_MODEL 的格式是 provider/model，比如 {example}'), { name, example: DEFAULT_MODEL }] };
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    try {
      this.watches = JSON.parse(await readFile(this.watchFile, 'utf8')) as Watch[];
    } catch {
      /* none */
    }
    // Batches that finished while the server was down.
    setTimeout(() => this.checkWatches(), 3000);
    if (!this.model) return;
    const auth = await this.models.checkAuth(this.model.provider).catch(() => undefined);
    const env = this.model.provider === 'custom' ? 'AGENT_API_KEY' : `${this.model.provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
    Object.assign(
      this.state,
      auth
        ? { ready: true, issue: undefined }
        : { ready: false, issue: [msg('还没有配置 {provider} 的 API key：在项目根目录的 .env 里加一行 {env}=你的key，然后重启服务'), { provider: this.model.provider, env }] },
    );
  }

  async view(projectId: string): Promise<AgentView> {
    const s = await this.session(projectId);
    return { entries: this.entries(s), running: s.running, usage: s.usage };
  }

  /** Starts a run, or steers the one in progress. Returns once the message is accepted. */
  async send(projectId: string, input: { text?: string; selection?: string[]; view?: { x: number; y: number } }) {
    if (!this.state.ready) throw new RequestError(this.status.reason ?? t('画布助手还没有配置好'));
    const text = input.text?.trim();
    if (!text) throw new RequestError(t('请输入内容'));
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
    this.syncPolicy(s);
    s.running = true;
    this.emit({ projectId, running: true });
    s.done = this.run(s, message);
  }

  /** Tells the model when the commercial-only switch or the interface language changed since it was last told (only between runs). */
  private syncPolicy(s: Session) {
    if (s.running) return;
    const on = Boolean(this.deps.commercialOnly?.());
    if (on !== s.commercial) {
      s.commercial = on;
      s.agent.state.messages = [...s.agent.state.messages, { role: 'system', content: commercialRules(on), timestamp: Date.now() }];
    }
    const lang = serverLang();
    if (lang !== s.lang) {
      s.lang = lang;
      s.agent.state.messages = [...s.agent.state.messages, { role: 'system', content: languageRule(lang), timestamp: Date.now() }];
    }
  }

  async abort(projectId: string) {
    const s = await this.sessions.get(projectId);
    if (!s) return;
    s.agent.clearAllQueues();
    s.agent.abort();
    if (this.dropWatches(projectId)) this.event(s, t('已停止：已提交的任务会继续跑，跑完后助手不会再自动接着做'));
  }

  /** The user's answer to work a tool held for approval. */
  async approve(projectId: string, id: string, ok: boolean) {
    const s = await this.session(projectId);
    const result = s.agent.state.messages.find((m) => m.role === 'toolResult' && m.toolCallId === id) as ToolResultMessage | undefined;
    const details = result?.details as ToolDetails | undefined;
    const approval = details?.approval;
    if (!result || !details || !approval) throw new RequestError(t('找不到这个确认请求'));
    if (approval.state !== 'pending') throw new RequestError(t('这个请求已经处理过了'));
    const tool = this.labels.get(result.toolName);
    const show = () => this.emit({ projectId, entry: this.resultEntry(id, result.toolName, result, Date.now()) });
    if (!ok) {
      approval.state = 'rejected';
      details.summary = t('没有确认');
      show();
      await this.save(s);
      this.wake(s, t('用户没有确认「{title}」，什么都没提交。\n先别生成，问问用户想怎么调整。', { title: approval.title }));
      return;
    }
    if (!tool?.approve) throw new RequestError(t('这个请求已经不能执行了'));
    approval.state = 'approved';
    details.summary = t('已确认，正在提交…');
    show();
    try {
      const out = await tool.approve(approval.payload, this.context(s));
      details.summary = out.summary;
      if (out.items?.length) details.items = out.items;
    } catch (err) {
      // Left pending so the user can try again (e.g. once ComfyUI is back).
      approval.state = 'pending';
      details.summary = t('提交失败：{message}', { message: (err as Error).message });
      throw err;
    } finally {
      show();
      await this.save(s);
    }
  }

  async clear(projectId: string) {
    const s = await this.session(projectId);
    this.dropWatches(projectId);
    s.agent.clearAllQueues();
    s.agent.abort();
    // After the run's own save, which would otherwise write the old conversation back.
    await s.done;
    s.agent.reset();
    s.archived = [];
    s.usage = { tokens: 0, cost: 0 };
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
    this.dropWatches(projectId);
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
    if (!ID.test(projectId) || !(await this.deps.projects.get(projectId))) throw new RequestError(t('画布不存在'));
    if (!this.model) throw new RequestError(this.status.reason ?? t('画布助手还没有配置好'));
    let saved: { messages?: AgentMessage[]; usage?: AgentUsage; archived?: AgentEntry[] } = {};
    try {
      saved = JSON.parse(await readFile(this.file(projectId), 'utf8'));
    } catch {
      /* new conversation */
    }
    const messages = saved.messages ?? [];
    const commercial = Boolean(this.deps.commercialOnly?.());
    const s = {
      projectId,
      running: false,
      interrupt: new AbortController(),
      autoRuns: 0,
      commercial,
      lang: serverLang(),
      usage: saved.usage ?? usageOf(messages),
      archived: saved.archived ?? [],
    } as unknown as Session;
    s.agent = new Agent({
      initialState: {
        systemPrompt: systemPrompt(this.state.vision, commercial, s.lang),
        model: this.model,
        thinkingLevel: this.thinking,
        tools: this.tools.map((def) => this.agentTool(def, s)),
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
    const tracked = items.filter((i) => i.taskId).map((i) => ({ id: i.id, ...(i.name ? { name: i.name } : {}), taskId: i.taskId! }));
    if (!tracked.length) return;
    this.watches.push({ projectId: s.projectId, what, items: tracked });
    void this.saveWatches();
  }

  private unwatch(s: Session, ids: string[]) {
    const known = new Set(ids);
    this.watches = this.watches
      .map((w) => (w.projectId === s.projectId ? { ...w, items: w.items.filter((i) => !known.has(i.id)) } : w))
      .filter((w) => w.items.length);
    void this.saveWatches();
  }

  /** Forgets a board's pending notices; whether there were any. */
  private dropWatches(projectId: string): boolean {
    const before = this.watches.length;
    this.watches = this.watches.filter((w) => w.projectId !== projectId);
    if (this.watches.length === before) return false;
    void this.saveWatches();
    return true;
  }

  private async saveWatches() {
    await writeFile(`${this.watchFile}.tmp`, JSON.stringify(this.watches));
    await rename(`${this.watchFile}.tmp`, this.watchFile);
  }

  private onTask(t: Task) {
    if (ACTIVE.has(t.status)) return;
    // A wait_for_items call sees the same event and marks its items as seen; let it go first.
    setTimeout(() => this.checkWatches(t.id), 500);
  }

  /** Notices for batches that are over (all of them, or those with this task). */
  private checkWatches(taskId?: string) {
    for (const w of [...this.watches]) {
      if (taskId && !w.items.some((i) => i.taskId === taskId)) continue;
      const tasks = this.deps.tasks.list(w.items.map((i) => i.taskId));
      if (tasks.some((x) => ACTIVE.has(x.status))) continue;
      this.watches = this.watches.filter((x) => x !== w);
      void this.saveWatches();
      this.session(w.projectId).then(
        (s) => this.finished(s, w, tasks),
        (err) => console.error('agent: could not resume a board', err),
      );
    }
  }

  /** A watched batch is over: tell the agent what came out, so it carries on. */
  private finished(s: Session, w: Watch, tasks: Task[]) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const label = (i: Watch['items'][number]) => `${i.name ? `${i.name} ` : ''}\`${i.id}\``;
    const ok = w.items.filter((i) => byId.get(i.taskId)?.status === 'done');
    const bad = w.items.filter((i) => byId.get(i.taskId)?.status !== 'done');
    const lines = [
      bad.length
        ? t('{what}都结束了：{n} 个完成，{bad} 个失败或取消。', { what: w.what, n: ok.length, bad: bad.length })
        : t('{what}都结束了：{n} 个完成。', { what: w.what, n: ok.length }),
      ...bad.map((i) => {
        const task = byId.get(i.taskId);
        return `- ${label(i)}: ${task ? (task.status === 'cancelled' ? t('已取消') : t(task.error ?? '失败')) : t('任务记录丢失')}`;
      }),
      ok.length ? t('完成的节点：{list}', { list: ok.map(label).join(', ') }) : '',
      t('接着做下一步；需要用户决定的事就停下来问。'),
    ];
    this.wake(s, lines.filter(Boolean).join('\n'));
  }

  /** Starts (or queues) a run on something the user did not type. */
  private wake(s: Session, text: string) {
    if (!this.state.ready) return;
    if (++s.autoRuns > MAX_AUTO_RUNS) {
      this.event(s, t('自动继续的次数到上限了，先停在这里；说一句「继续」让助手接着做'));
      return;
    }
    const message: UserMessage = { role: 'user', content: `<canvas_event>${text}</canvas_event>`, timestamp: Date.now() };
    this.emit({ projectId: s.projectId, entry: userEntry(message) });
    if (s.running) {
      s.agent.followUp(message);
      return;
    }
    this.syncPolicy(s);
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
      await this.compactIfLong(s);
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
      this.emit({ projectId: s.projectId, running: false, usage: s.usage });
    }
  }

  /**
   * Long conversations cost more on every request: once the last request's context passed `compactAt`,
   * everything before the last few user turns is condensed by the model into a summary. The panel keeps
   * the old rows.
   */
  private async compactIfLong(s: Session) {
    const messages = s.agent.state.messages;
    const last = messages.findLast((m) => m.role === 'assistant') as AssistantMessage | undefined;
    const u = last?.usage;
    if (!this.model || !u || u.input + u.cacheRead + u.cacheWrite + u.output < this.compactAt) return;
    const turns = messages.flatMap((m, i) => (m.role === 'user' ? [i] : []));
    if (turns.length <= KEEP_TURNS) return;
    const cut = turns[turns.length - KEEP_TURNS];
    const early = messages.slice(0, cut);
    const old = early.filter((m) => m.role !== 'system');
    if (old.length < 4) return;
    this.event(s, t('对话比较长了，正在把较早的部分整理成摘要…'));
    const reply = await this.models.completeSimple(this.model, {
      systemPrompt: SUMMARY_PROMPT,
      messages: [{ role: 'user', content: transcriptText(old), timestamp: Date.now() }],
    });
    const summary = reply.content
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('')
      .trim();
    this.addUsage(s, reply);
    if (reply.stopReason === 'error' || !summary) {
      this.event(s, t('整理摘要没成功，先保持原样'));
      return;
    }
    s.archived = [...s.archived, ...this.entriesOf(old, s)];
    s.agent.state.messages = [
      ...early.filter((m) => m.role === 'system'),
      { role: 'user', content: `<canvas_summary>\n${summary}\n</canvas_summary>`, timestamp: Date.now() },
      ...messages.slice(cut),
    ];
    await this.save(s);
  }

  private addUsage(s: Session, m: AssistantMessage) {
    s.usage = { tokens: s.usage.tokens + (m.usage?.totalTokens ?? 0), cost: s.usage.cost + (m.usage?.cost?.total ?? 0) };
  }

  private async save(s: Session) {
    const messages = s.agent.state.messages.filter((m) => m.role !== 'system').map(withoutImages);
    const file = this.file(s.projectId);
    await writeFile(`${file}.tmp`, JSON.stringify({ version: 2, messages, usage: s.usage, archived: s.archived }));
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
    const def = this.labels.get(tool);
    const details = (result?.details ?? {}) as ToolDetails;
    const approval = details.approval;
    const base = { kind: 'tool' as const, id, tool, label: def ? t(def.label) : tool, at, ...(details.items?.length ? { items: details.items } : {}) };
    if (!result) return { ...base, status: running ? 'running' : 'error', summary: running ? (def?.describe(args as Record<string, unknown>) ?? '') : t('没有完成') };
    if (result.isError) return { ...base, status: 'error', summary: clip(textOf(result.content), 300) };
    if (approval?.state === 'pending') return { ...base, status: 'waiting', summary: details.summary ?? '', approval: { title: approval.title, detail: approval.detail } };
    return { ...base, status: approval?.state === 'rejected' ? 'error' : 'done', summary: details.summary ?? '' };
  }

  /** The panel's view of the conversation: condensed rows first, then the transcript. */
  private entries(s: Session): AgentEntry[] {
    const { messages, streamingMessage } = s.agent.state;
    return [...s.archived, ...this.entriesOf(streamingMessage ? [...messages, streamingMessage] : messages, s)];
  }

  private entriesOf(all: AgentMessage[], s: Session): AgentEntry[] {
    const { streamingMessage, pendingToolCalls } = s.agent.state;
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
        if (e.message.role === 'assistant') {
          this.pushText(s, assistantEntry(e.message), true);
          this.addUsage(s, e.message);
          this.emit({ projectId: s.projectId, usage: s.usage });
        }
        break;
      case 'tool_execution_start': {
        const def = this.labels.get(e.toolName);
        emit({ kind: 'tool', id: e.toolCallId, tool: e.toolName, label: def ? t(def.label) : e.toolName, status: 'running', summary: def?.describe(e.args) ?? '', at: Date.now() });
        break;
      }
      case 'tool_execution_update': {
        const def = this.labels.get(e.toolName);
        const summary = (e.partialResult?.details as ToolDetails | undefined)?.summary ?? '';
        emit({ kind: 'tool', id: e.toolCallId, tool: e.toolName, label: def ? t(def.label) : e.toolName, status: 'running', summary, at: Date.now() });
        break;
      }
      case 'tool_execution_end':
        emit(this.resultEntry(e.toolCallId, e.toolName, { isError: e.isError, content: e.result?.content ?? [], details: e.result?.details }, Date.now()));
        break;
    }
  }
}

import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type ThinkingLevel } from '@earendil-works/pi-agent-core';
import {
  type Api,
  type ApiKeyAuth,
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
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { AgentEntry, AgentEventData, AgentStatus, AgentUsage, AgentView, CanvasItem, Task } from '../../shared/types.ts';
import { type Lang, type Vars, msg } from '../../shared/i18n.ts';
import { config } from '../config.ts';
import { serverLang, t } from '../i18n.ts';
import type { SettingsStore } from '../settings.ts';
import { RequestError } from '../workflows/index.ts';
import { type CanvasDeps, ResultWriter, describeItem, readBoard } from './board.ts';
import { speedNote } from './estimate.ts';
import { SUMMARY_PROMPT, commercialRules, languageRule, systemPrompt } from './prompt.ts';
import { type CanvasTool, type Json, type ToolContext, canvasTools } from './tools.ts';
import { writeJson } from './write.ts';

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
/** Context size (tokens of the last request) at which the early conversation is condensed, for large windows. */
const COMPACT_AT = 100_000;
/** The user's own messages carried word for word through condensing: each clipped, all within a budget. */
const WORD_CHARS = 1500;
const WORDS_BUDGET = 6000;
const SAID = /<said>([\s\S]*?)<\/said>/g;
const WORDS_HEAD = /\n*用户说过的原话（[^\n]*：\s*$/;
/** The latest tool calls keep their results and arguments when old ones are cleared. */
const KEEP_RESULTS = 6;
/** Tool results and arguments shorter than this stay: little to gain. */
const CLEAR_MIN_CHARS = 600;
/** Clearing rebuilds the cache from the first message it changes: only done when it frees this much text. */
const CLEAR_WORTH = 12_000;
/** Starts what clearing leaves in place of a result or an argument. */
const CLEARED = '[已清掉';
/** Context length assumed for an OpenAI-compatible endpoint that does not say. */
const CUSTOM_CONTEXT = 128_000;
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
  /** `replaced`: a newer card of the same tool took its place before the user answered. */
  approval?: { title: string; detail: string; state: 'pending' | 'approved' | 'rejected' | 'replaced'; payload: Json; frames?: string[]; since?: number; confirm?: string };
}

const AGENT_APPROVAL = '__infinode_agent_approval';

const ACTIVE = new Set(['queued', 'running']);

/**
 * AGENT_BASE_URL: any OpenAI-compatible endpoint (豆包、百炼、Ollama、vLLM…), with AGENT_MODEL naming the model there.
 * pi-ai trims each request's max tokens to what the context window leaves, so the window has to be the server's real one.
 */
function customProvider(baseUrl: string, modelId: string, apiKey: string | undefined, opts: { vision: boolean; reasoning: boolean; contextWindow?: number }): Provider {
  const model: Model<'openai-completions'> = {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'custom',
    baseUrl,
    reasoning: opts.reasoning,
    input: opts.vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: opts.contextWindow ?? CUSTOM_CONTEXT,
    // Thinking shares the output budget with the answer.
    maxTokens: opts.reasoning ? 32_768 : 8192,
  };
  return createProvider({
    id: 'custom',
    name: modelId,
    baseUrl,
    auth: {
      apiKey: {
        name: 'API key',
        resolve: async ({ signal }) => {
          signal.throwIfAborted();
          return apiKey ? { auth: { apiKey }, source: 'settings' } : undefined;
        },
      } satisfies ApiKeyAuth,
    },
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

/**
 * Tokens the panel counts: all but cache reads. A long conversation re-reads the whole context from the
 * cache on every request, at a sliver of the price; counted in, millions of tokens would cost a few cents.
 */
function paidTokens(u: AssistantMessage['usage'] | undefined): number {
  return u ? u.input + u.output + u.cacheWrite : 0;
}

function usageOf(messages: AgentMessage[]): AgentUsage {
  const usage = { tokens: 0, cost: 0 };
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    usage.tokens += paidTokens(m.usage);
    usage.cost += m.usage?.cost?.total ?? 0;
  }
  return usage;
}

/**
 * Saves before version 3 counted cache reads in. The messages still there are recounted; the condensed
 * part, whose messages are gone, keeps the share of cache reads the rest of the conversation had.
 */
function recount(saved: AgentUsage, messages: AgentMessage[]): AgentUsage {
  const assistant = messages.filter((m) => m.role === 'assistant');
  const all = assistant.reduce((n, m) => n + (m.usage?.totalTokens ?? 0), 0);
  const paid = assistant.reduce((n, m) => n + paidTokens(m.usage), 0);
  const gone = Math.max(0, saved.tokens - all);
  return { tokens: Math.round(paid + gone * (all ? paid / all : 1)), cost: saved.cost };
}

/**
 * When to condense: well inside the model's window, since a run adds tool results and images before the
 * next check, and the summary request itself has to fit.
 */
export function compactThreshold(contextWindow: number | undefined): number {
  return contextWindow && contextWindow > 0 ? Math.min(COMPACT_AT, Math.floor(contextWindow * 0.6)) : COMPACT_AT;
}

/** The early conversation as plain text for the summary (long parts clipped to `max` characters in all). */
function transcriptText(messages: AgentMessage[], max: number): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const text = textOf(m.content).trim();
      lines.push(SUMMARY.test(text) ? `【之前的整理】${summaryText(text)}` : `【用户】${clip(text, 2000)}`);
    }
    else if (m.role === 'toolResult') lines.push(`【结果】${clip(textOf(m.content), 800)}`);
    else if (m.role === 'assistant') {
      for (const c of m.content) {
        if (c.type === 'text' && c.text.trim()) lines.push(`【助手】${clip(c.text.trim(), 2000)}`);
        if (c.type === 'toolCall') lines.push(`【调用 ${c.name}】${clip(JSON.stringify(c.arguments), 600)}`);
      }
    }
  }
  return clip(lines.join('\n'), max);
}

/** A summary message without its tags and the user's words carried in it. */
function summaryText(message: string): string {
  return message.replace(/^<canvas_summary>\n?/, '').replace(/\n?<\/canvas_summary>$/, '').replace(SAID, '').replace(WORDS_HEAD, '').trim();
}

/**
 * What the user typed in these messages, oldest first, without the board context: those words are what
 * a summary loses most easily, and the events that resume a long batch would otherwise push them out.
 */
function userWords(messages: AgentMessage[]): string[] {
  const words: string[] = [];
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const raw = textOf(m.content).trim();
    if (SUMMARY.test(raw)) words.push(...[...raw.matchAll(SAID)].map((x) => x[1].trim()));
    else if (!EVENT.test(raw)) words.push(raw.replace(CONTEXT, '').trim());
  }
  return words.filter(Boolean).map((w) => clip(w, WORD_CHARS));
}

/** The summary as the model reads it: the condensed text, then the user's first words and as many recent ones as fit. */
function summaryMessage(summary: string, words: string[]): string {
  const keep = new Set<number>(words.length ? [0] : []);
  let used = words[0]?.length ?? 0;
  for (let i = words.length - 1; i > 0 && used + words[i].length <= WORDS_BUDGET; i--) {
    keep.add(i);
    used += words[i].length;
  }
  const skipped = words.length - keep.size;
  const said = words.filter((_, i) => keep.has(i)).map((w) => `<said>${w}</said>`);
  const quoted = said.length
    ? `\n\n用户说过的原话（按时间顺序，长的截断了${skipped ? `；中间有 ${skipped} 条没列出，要点在上面的整理里` : ''}）：\n${said.join('\n')}`
    : '';
  return `<canvas_summary>\n${summary}${quoted}\n</canvas_summary>`;
}

/** Long strings anywhere in a tool call's arguments, replaced by their length. */
function clearArgs(value: unknown): { value: unknown; freed: number } {
  if (typeof value === 'string') {
    if (value.length <= CLEAR_MIN_CHARS || value.startsWith(CLEARED)) return { value, freed: 0 };
    const line = `${CLEARED} ${value.length} 字，原文在画布上]`;
    return { value: line, freed: value.length - line.length };
  }
  if (!value || typeof value !== 'object') return { value, freed: 0 };
  let freed = 0;
  const each = (v: unknown) => {
    const r = clearArgs(v);
    freed += r.freed;
    return r.value;
  };
  const out = Array.isArray(value) ? value.map(each) : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, each(v)]));
  return { value: out, freed };
}

/**
 * Old tool results and long tool arguments, each replaced by a line saying what was there (what Anthropic
 * calls context editing): the board can be read again, and notes and prompts are on it. The last `keep`
 * calls stay whole, and so do errors, which the panel shows. `cleared`: places changed; `freed`: characters.
 */
export function clearOldToolUse(messages: AgentMessage[], keep = KEEP_RESULTS): { messages: AgentMessage[]; freed: number; cleared: number } {
  const calls = messages.flatMap((m) => (m.role === 'assistant' ? m.content.flatMap((c) => (c.type === 'toolCall' ? [c.id] : [])) : []));
  const kept = new Set(keep > 0 ? calls.slice(-keep) : []);
  let freed = 0;
  let cleared = 0;
  const out = messages.map((m): AgentMessage => {
    if (m.role === 'toolResult') {
      const text = textOf(m.content);
      if (kept.has(m.toolCallId) || m.isError || text.length <= CLEAR_MIN_CHARS || text.startsWith(CLEARED)) return m;
      const line = `${CLEARED}较早的 ${m.toolName} 结果，${text.length} 字，需要时重新调用]`;
      freed += text.length - line.length;
      cleared++;
      return { ...m, content: [{ type: 'text', text: line }] };
    }
    if (m.role !== 'assistant') return m;
    let changed = false;
    const content = m.content.map((c) => {
      if (c.type !== 'toolCall' || kept.has(c.id)) return c;
      const r = clearArgs(c.arguments);
      if (!r.freed) return c;
      freed += r.freed;
      cleared++;
      changed = true;
      return { ...c, arguments: r.value as typeof c.arguments };
    });
    return changed ? { ...m, content } : m;
  });
  return { messages: out, freed, cleared };
}

function userEntry(m: UserMessage): AgentEntry {
  const raw = textOf(m.content);
  const event = EVENT.exec(raw.trim());
  if (event) return { kind: 'event', id: `u${m.timestamp}`, text: event[1].trim().split('\n')[0], at: m.timestamp };
  if (SUMMARY.test(raw.trim())) return { kind: 'event', id: `u${m.timestamp}`, text: t('较早的对话已整理成摘要，助手按摘要继续'), detail: summaryText(raw.trim()), at: m.timestamp };
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
  private state!: Omit<AgentStatus, 'reason'> & { issue?: [string, Vars?] };

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
  private compactAt = COMPACT_AT;
  private clearAt = Math.floor(COMPACT_AT / 2);
  private models: Models;
  private model?: Model<Api>;
  private thinking!: ThinkingLevel;
  private vision = false;
  private approvalMode: 'risky' | 'always' = 'risky';
  private readonly tools: CanvasTool[];
  private readonly labels: Map<string, CanvasTool>;
  private readonly opts: { models?: Models; model?: string; compactAt?: number; clearAt?: number };
  private readonly settings?: SettingsStore;

  constructor(
    private readonly deps: CanvasDeps,
    private readonly emit: (e: AgentEventData) => void,
    /** For tests: another model collection and "provider/model", and when to clear old tool use and condense. */
    opts: { models?: Models; model?: string; compactAt?: number; clearAt?: number } = {},
    settings?: SettingsStore,
  ) {
    this.opts = opts;
    this.settings = settings;
    this.watchFile = join(this.dir, 'watches.json');
    this.models = opts.models ?? builtinModels();
    this.tools = canvasTools(deps, new ResultWriter(deps));
    this.labels = new Map(this.tools.map((t) => [t.name, t]));
    this.configureModel();
    deps.tasks.on('task', (t: Task) => this.onTask(t));
    this.setModelState();
  }

  private configureModel() {
    const cfg = this.settings?.agentConfig() ?? {
      model: this.opts.model ?? (process.env.AGENT_MODEL?.trim() || DEFAULT_MODEL),
      baseUrl: process.env.AGENT_BASE_URL?.trim() || undefined,
      apiKey: process.env.AGENT_API_KEY?.trim() || undefined,
      vision: process.env.AGENT_VISION === '1',
      thinking: process.env.AGENT_THINKING?.trim() || 'low',
      approvalMode: 'risky' as const,
      contextWindow: Number(process.env.AGENT_CONTEXT_WINDOW) || undefined,
      reasoning: process.env.AGENT_REASONING === '1',
    };
    const models = this.opts.models ?? builtinModels();
    let name = cfg.model;
    if (cfg.baseUrl && !this.opts.models) {
      (models as ReturnType<typeof builtinModels>).setProvider(customProvider(cfg.baseUrl, name, cfg.apiKey, cfg));
      name = `custom/${name}`;
    }
    this.models = models;
    const slash = name.indexOf('/');
    this.model = slash > 0 ? this.models.getModel(name.slice(0, slash), name.slice(slash + 1)) : undefined;
    this.vision = Boolean(this.model?.input.includes('image'));
    this.compactAt = this.opts.compactAt ?? compactThreshold(this.model?.contextWindow);
    // Halfway there: clearing keeps most conversations from ever needing a summary.
    this.clearAt = this.opts.clearAt ?? Math.floor(this.compactAt / 2);
    this.approvalMode = cfg.approvalMode;
    const wanted = cfg.thinking as ThinkingLevel;
    this.thinking = !this.model?.reasoning ? 'off' : (clampThinkingLevel(this.model, THINKING.has(wanted) ? wanted : 'low') as ThinkingLevel);
  }

  private setModelState() {
    const name = this.model ? `${this.model.provider}/${this.model.id}` : this.settings?.agentConfig().model ?? this.opts.model ?? (process.env.AGENT_MODEL?.trim() || DEFAULT_MODEL);
    this.state = this.model
      ? { ready: false, model: name, vision: this.vision, issue: [msg('正在检查模型配置')] }
      : { ready: false, model: name, vision: this.vision, issue: [msg('找不到模型 {name}：AGENT_MODEL 的格式是 provider/model，比如 {example}'), { name, example: DEFAULT_MODEL }] };
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
    await this.refreshAuth();
  }

  /** Apply settings immediately. Existing conversations are reopened from disk with the new model. */
  async reconfigure() {
    for (const s of this.live.values()) {
      s.agent.clearAllQueues();
      s.agent.abort();
      await s.done?.catch(() => {});
    }
    this.sessions.clear();
    this.live.clear();
    this.configureModel();
    this.setModelState();
    await this.refreshAuth();
  }

  private async refreshAuth() {
    if (!this.model) return;
    const auth = await this.models.checkAuth(this.model.provider).catch(() => undefined);
    const keylessCustom = this.model.provider === 'custom' && !this.settings?.agentConfig().apiKey && !process.env.AGENT_API_KEY?.trim();
    const env = this.model.provider === 'custom' ? 'AGENT_API_KEY' : `${this.model.provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
    Object.assign(
      this.state,
      auth
        ? { ready: true, issue: undefined }
        : keylessCustom
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
    s.done = this.run(s, [message]);
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
      this.wake(s, t('用户没有确认「{title}」，这一步没有执行。\n先别接着做，问问用户想怎么调整。', { title: approval.title }));
      return;
    }
    const pendingPayload = approval?.payload;
    const isGenericOperation = pendingPayload && typeof pendingPayload === 'object' && !Array.isArray(pendingPayload) && pendingPayload[AGENT_APPROVAL] === true;
    if (!tool || (!tool.approve && !isGenericOperation)) throw new RequestError(t('这个请求已经不能执行了'));
    approval.state = 'approved';
    details.summary = t('已确认，正在提交…');
    show();
    try {
      const payload = approval.payload as Json;
      const operation = payload && typeof payload === 'object' && !Array.isArray(payload) && payload[AGENT_APPROVAL] === true ? payload : undefined;
      const out = tool.approve
        ? await tool.approve(payload, this.context(s))
        : operation
          ? await tool.run(operation.args as Record<string, unknown>, this.context(s))
          : undefined;
      if (!out) throw new RequestError(t('这个请求已经不能执行了'));
      // The model now reads what was done, not the "waiting for the user" it got when the card was made.
      result.content = [{ type: 'text', text: `用户已确认。${out.text}` }];
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
    let saved: { version?: number; messages?: AgentMessage[]; usage?: AgentUsage; archived?: AgentEntry[] } = {};
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
      usage: !saved.usage ? usageOf(messages) : (saved.version ?? 0) < 3 ? recount(saved.usage, messages) : saved.usage,
      archived: saved.archived ?? [],
    } as unknown as Session;
    s.agent = new Agent({
      initialState: {
        systemPrompt: systemPrompt(this.state.vision, commercial, s.lang),
        model: this.model,
        thinkingLevel: this.thinking,
        tools: this.tools.filter((def) => this.vision || !def.vision).map((def) => this.agentTool(def, s)),
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

  /** Never rejects: callers fire and forget, and an unhandled rejection would stop the server. */
  private saveWatches() {
    return writeJson(this.watchFile, () => this.watches).catch((err) => console.error('agent: could not save the watches', err));
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
    s.done = this.run(s, [message]);
  }

  /** A line in the panel only (not sent to the model). */
  private event(s: Session, text: string) {
    this.emit({ projectId: s.projectId, entry: { kind: 'event', id: `n${Date.now()}`, text, at: Date.now() } });
  }

  private agentTool(def: CanvasTool, s: Session): AgentTool<TSchema, ToolDetails> {
    return {
      name: def.name,
      label: def.label,
      description: def.description,
      parameters: Type.Unsafe(def.parameters as unknown as TSchema),
      execute: async (_id, args, signal, onUpdate) => {
        // Tools with their own card (video batches, deleting) already ask, with more to say than this one.
        if (this.approvalMode === 'always' && !def.readOnly && !def.approve) {
          const summary = def.describe(args as Record<string, unknown>);
          return {
            content: [{ type: 'text', text: t('等待用户确认后再执行。') }],
            details: {
              summary: t('等待确认'),
              approval: {
                title: t('确认助手操作「{label}」', { label: t(def.label) }),
                detail: summary ? t('助手准备执行：{summary}。确认后才会修改画布或提交任务。', { summary }) : t('助手准备执行这项会修改画布或提交任务的操作。确认后才会执行。'),
                state: 'pending' as const,
                payload: { [AGENT_APPROVAL]: true, args: args as unknown as Json },
              },
            },
          };
        }
        const out = await def.run(
          args as Record<string, unknown>,
          this.context(s, { signal, progress: (text) => onUpdate?.({ content: [{ type: 'text', text }], details: { summary: text } }) }),
        );
        if (out.approval) this.replaceCards(s, def.name);
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

  /**
   * A tool asked for approval again before the user answered its last card: that card goes, so the two
   * cannot both be confirmed (e.g. the same videos queued twice after a keyframe was redone).
   */
  private replaceCards(s: Session, tool: string) {
    for (const m of s.agent.state.messages) {
      if (m.role !== 'toolResult' || m.toolName !== tool) continue;
      const details = m.details as ToolDetails | undefined;
      if (details?.approval?.state !== 'pending') continue;
      details.approval.state = 'replaced';
      details.summary = t('已被新的确认卡取代');
      this.emit({ projectId: s.projectId, entry: this.resultEntry(m.toolCallId, m.toolName, m as ToolResultMessage, Date.now()) });
    }
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
    lines.push(speedNote(this.deps.tasks.list()));
    return `<canvas_context selection="${selected.map((i) => i.id).join(',')}">\n${lines.join('\n')}\n</canvas_context>\n\n`;
  }

  private async run(s: Session, first: AgentMessage[]) {
    try {
      await this.manageContext(s);
      let next: AgentMessage[] = first;
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
   * Long conversations cost more on every request. Measured by the last request's context: past `clearAt`,
   * old tool results and long tool arguments go first (no model call, and they can be read again); past
   * `compactAt`, the early conversation is condensed into a summary. Either one makes the next request
   * rebuild the cache, so each happens rarely and in one go.
   */
  private async manageContext(s: Session) {
    const last = s.agent.state.messages.findLast((m) => m.role === 'assistant') as AssistantMessage | undefined;
    const u = last?.usage;
    if (!this.model || !u) return;
    const size = u.input + u.cacheRead + u.cacheWrite + u.output;
    if (size >= this.compactAt) await this.compact(s, KEEP_TURNS);
    else if (size >= this.clearAt) await this.clearOld(s);
  }

  /** Clears old tool use when that frees enough to be worth a cache rebuild. */
  private async clearOld(s: Session) {
    const { messages, freed, cleared } = clearOldToolUse(s.agent.state.messages);
    if (freed < CLEAR_WORTH) return;
    s.agent.state.messages = messages;
    this.event(s, t('已清掉 {n} 处较早的工具结果，上下文少了 {chars} 字', { n: cleared, chars: freed }));
    await this.save(s);
  }

  /**
   * Condenses everything before the last `keep` user turns into a summary, with what the user typed carried
   * along word for word; `focus`: what the user asked to keep in particular. The panel keeps the old rows.
   * `short`: too little to condense yet.
   */
  private async compact(s: Session, keep: number, focus?: string): Promise<'done' | 'short' | 'failed'> {
    const messages = s.agent.state.messages;
    const turns = messages.flatMap((m, i) => (m.role === 'user' ? [i] : []));
    if (!this.model || turns.length <= keep) return 'short';
    const cut = turns[turns.length - keep];
    const early = messages.slice(0, cut);
    const old = early.filter((m) => m.role !== 'system');
    if (old.length < 4) return 'short';
    this.event(s, focus === undefined ? t('对话比较长了，正在把较早的部分整理成摘要…') : t('正在把较早的对话整理成摘要…'));
    // In characters: Chinese runs about a token each, so this fits even a small window.
    const transcript = transcriptText(old, Math.min(120_000, Math.floor((this.model.contextWindow || Infinity) * 0.6)));
    const reply = await this.models.completeSimple(this.model, {
      systemPrompt: SUMMARY_PROMPT,
      messages: [{ role: 'user', content: focus ? `用户希望这次整理特别保留：${focus}\n\n${transcript}` : transcript, timestamp: Date.now() }],
    });
    const summary = reply.content
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('')
      .trim();
    this.addUsage(s, reply);
    if (reply.stopReason === 'error' || !summary) {
      this.event(s, t('整理摘要没成功，先保持原样'));
      return 'failed';
    }
    const condensed: UserMessage = { role: 'user', content: summaryMessage(summary, userWords(old)), timestamp: Date.now() };
    s.archived = [...s.archived, ...this.entriesOf(old, s)];
    s.agent.state.messages = [...early.filter((m) => m.role === 'system'), condensed, ...messages.slice(cut)];
    this.emit({ projectId: s.projectId, entry: userEntry(condensed) });
    await this.save(s);
    return 'done';
  }

  /**
   * The user asked to condense now: everything before their last message, keeping `focus` in particular.
   * Messages sent meanwhile wait, then start a run.
   */
  async condense(projectId: string, focus?: string) {
    const s = await this.session(projectId);
    if (!this.state.ready) throw new RequestError(this.status.reason ?? t('画布助手还没有配置好'));
    if (s.running) throw new RequestError(t('助手正在工作，等它停下来再整理'));
    s.running = true;
    this.emit({ projectId, running: true });
    let result: 'done' | 'short' | 'failed' = 'failed';
    try {
      result = await this.compact(s, 1, focus?.trim().slice(0, 500) ?? '');
    } finally {
      const queued = s.agent.peekQueuedMessages();
      s.agent.clearAllQueues();
      if (queued.length) {
        s.done = this.run(s, queued);
      } else {
        s.running = false;
        this.emit({ projectId, running: false, usage: s.usage });
      }
    }
    if (result === 'short') throw new RequestError(t('对话还很短，没有可以整理的较早部分'));
    if (result === 'failed') throw new RequestError(t('整理摘要没成功，先保持原样'));
  }

  private addUsage(s: Session, m: AssistantMessage) {
    s.usage = { tokens: s.usage.tokens + paidTokens(m.usage), cost: s.usage.cost + (m.usage?.cost?.total ?? 0) };
  }

  /** In line behind any save still running (a run's last save can overlap the next run's first). */
  private save(s: Session) {
    return writeJson(this.file(s.projectId), () => ({
      // 3: usage.tokens leaves out cache reads.
      version: 3,
      messages: s.agent.state.messages.filter((m) => m.role !== 'system').map(withoutImages),
      usage: s.usage,
      archived: s.archived,
    }));
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
    if (approval?.state === 'pending') {
      const { title, detail, frames, since, confirm } = approval;
      return { ...base, status: 'waiting', summary: details.summary ?? '', approval: { title, detail, ...(frames ? { frames, since } : {}), ...(confirm ? { confirm } : {}) } };
    }
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

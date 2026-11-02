import { ArrowUp, CircleAlert, CircleCheck, Loader2, Sparkles, Square, SquarePen, X } from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useLayoutEffect, useRef } from 'react';
import { create } from 'zustand';
import type { AgentEntry, AgentEventData, AgentStatus } from '../../shared/types';
import { ensureVisible } from '../lib/actions';
import { api } from '../lib/api';
import { boundsOf, viewportCenter } from '../lib/geometry';
import { savePending } from '../project';
import { select, toast, useStore } from '../store';

const OPEN_KEY = 'infinode:agent';

/** Tools whose results are new board items worth bringing into view. */
const CREATES = new Set(['generate_image', 'generate_video', 'run_workflow']);

const SUGGESTIONS = ['把选中的图各做一段 5 秒视频', '用选中的人物图，生成他在雨夜街头的三张不同景别的照片', '看看选中的图有没有问题，有问题就重新生成'];

interface AgentState {
  open: boolean;
  status: AgentStatus | null;
  /** Board the conversation belongs to. */
  projectId: string | null;
  entries: AgentEntry[];
  running: boolean;
  draft: string;
}

export const useAgent = create<AgentState>(() => ({
  open: localStorage.getItem(OPEN_KEY) === 'open',
  status: null,
  projectId: null,
  entries: [],
  running: false,
  draft: '',
}));

function markOpen(open: boolean) {
  // Bottom panels make room for the side panel.
  document.body.classList.toggle('agent-open', open);
}
markOpen(useAgent.getState().open);

export function toggleAgent(open = !useAgent.getState().open) {
  useAgent.setState({ open });
  localStorage.setItem(OPEN_KEY, open ? 'open' : 'closed');
  markOpen(open);
}

/** Loads the open board's conversation (on opening the panel, switching boards and reconnecting). */
export async function refreshAgent() {
  const projectId = useStore.getState().projectId;
  if (!projectId || !useAgent.getState().open) return;
  try {
    const [status, view] = await Promise.all([api.agentStatus(), api.agent(projectId)]);
    if (useStore.getState().projectId !== projectId) return;
    useAgent.setState({ status, projectId, entries: view.entries, running: view.running });
  } catch (err) {
    useAgent.setState({ status: { ready: false, model: '', vision: false, reason: (err as Error).message }, projectId, entries: [], running: false });
  }
}

export function onAgentEvent(e: AgentEventData) {
  const s = useAgent.getState();
  if (e.projectId !== s.projectId) return;
  if (e.reset) {
    useAgent.setState({ entries: [], running: false });
    return;
  }
  const patch: Partial<AgentState> = {};
  if (e.running !== undefined) patch.running = e.running;
  const entry = e.entry;
  if (entry) {
    const i = s.entries.findIndex((x) => x.id === entry.id);
    patch.entries = i >= 0 ? s.entries.map((x, j) => (j === i ? entry : x)) : [...s.entries, entry];
    if (entry.kind === 'tool' && entry.status === 'done' && entry.items?.length && CREATES.has(entry.tool)) void reveal(entry.items);
  }
  useAgent.setState(patch);
}

/** Pans to new items once the board change that adds them has been merged in. */
async function reveal(ids: string[]) {
  for (let i = 0; i < 20; i++) {
    const items = useStore.getState().items.filter((it) => ids.includes(it.id));
    const bounds = boundsOf(items);
    if (bounds && items.length === ids.length) return ensureVisible(bounds);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function send() {
  const text = useAgent.getState().draft.trim();
  const { projectId, selection, viewport, screen } = useStore.getState();
  if (!text || !projectId) return;
  useAgent.setState({ draft: '' });
  try {
    // The agent reads the board from the server: let it see what was just added or moved.
    await savePending();
    await api.sendAgent(projectId, { text, selection, view: viewportCenter(viewport, screen.w, screen.h - 160) });
  } catch (err) {
    toast((err as Error).message, 'error');
    if (!useAgent.getState().draft) useAgent.setState({ draft: text });
  }
}

async function stop() {
  const { projectId } = useAgent.getState();
  if (projectId) await api.abortAgent(projectId).catch((err) => toast((err as Error).message, 'error'));
}

async function clear() {
  const { projectId, running } = useAgent.getState();
  if (!projectId || !confirm(running ? '助手还在工作，停止并清空这段对话？' : '清空这段对话？画布上的内容不受影响。')) return;
  await api.clearAgent(projectId).catch((err) => toast((err as Error).message, 'error'));
}

function focusItems(ids: string[]) {
  const items = useStore.getState().items.filter((i) => ids.includes(i.id));
  const bounds = boundsOf(items);
  if (!bounds) return toast('这些节点已经不在画布上了', 'info');
  select(items.map((i) => i.id));
  ensureVisible(bounds);
}

function ItemChip({ id }: { id: string }) {
  const item = useStore((s) => s.items.find((i) => i.id === id));
  if (!item) return <span className="agent-chip gone" title="已不在画布上" />;
  const media = item.asset;
  return (
    <button className="agent-chip" title={item.name ?? '在画布上查看'} onClick={() => focusItems([id])}>
      {media ? (
        media.kind === 'video' ? (
          <video src={`${media.url}#t=0.1`} muted preload="metadata" />
        ) : (
          <img src={media.url} alt="" />
        )
      ) : item.error ? (
        <CircleAlert className="bad" />
      ) : (
        <Loader2 className="spin" />
      )}
    </button>
  );
}

function Chips({ ids }: { ids: string[] }) {
  return (
    <div className="agent-chips">
      {ids.slice(0, 12).map((id) => (
        <ItemChip key={id} id={id} />
      ))}
      {ids.length > 12 && (
        <button className="agent-chip more" onClick={() => focusItems(ids)}>
          +{ids.length - 12}
        </button>
      )}
    </div>
  );
}

/** `**bold**` and `code` inside a line. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
      <b key={i}>{part.slice(2, -2)}</b>
    ) : part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
      <code key={i}>{part.slice(1, -1)}</code>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

/** The bits of Markdown models use most: headings, lists, bold, code. */
function Text({ text }: { text: string }) {
  return (
    <div className="agent-text">
      {text.split('\n').map((line, i) => {
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
        if (heading) return <p key={i} className="h">{inline(heading[1])}</p>;
        if (bullet) return <p key={i} className="li">• {inline(bullet[1])}</p>;
        if (/^\s*\d+[.、)]\s+/.test(line)) return <p key={i} className="li">{inline(line.trim())}</p>;
        return line.trim() ? <p key={i}>{inline(line)}</p> : <p key={i} className="gap" />;
      })}
    </div>
  );
}

function Entry({ entry }: { entry: AgentEntry }) {
  if (entry.kind === 'user') {
    return (
      <div className="agent-msg user">
        <div className="agent-bubble">{entry.text}</div>
        {entry.selection && <Chips ids={entry.selection} />}
      </div>
    );
  }
  if (entry.kind === 'assistant') {
    return (
      <div className="agent-msg assistant">
        {entry.text && <Text text={entry.text} />}
        {entry.error && (
          <div className="agent-error">
            <CircleAlert /> {entry.error}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className={`agent-tool ${entry.status}`}>
      <span className="agent-tool-icon">
        {entry.status === 'running' ? <Loader2 className="spin" /> : entry.status === 'done' ? <CircleCheck /> : <CircleAlert />}
      </span>
      <div className="agent-tool-main">
        <div className="agent-tool-line" title={entry.summary}>
          <b>{entry.label}</b>
          {entry.summary && <span>{entry.summary}</span>}
        </div>
        {entry.items && <Chips ids={entry.items} />}
      </div>
    </div>
  );
}

export function AgentButton() {
  const open = useAgent((s) => s.open);
  const running = useAgent((s) => s.running);
  return (
    <button className={`pill ${open ? 'on' : ''} ${running ? 'busy' : ''}`} onClick={() => toggleAgent()} title="画布助手：说一句话，让它在画布上出图、出视频">
      {running ? <Loader2 className="spin" /> : <Sparkles />} 助手
    </button>
  );
}

export function AgentPanel() {
  const { open, status, entries, running, draft } = useAgent();
  const projectId = useStore((s) => s.projectId);
  const selected = useStore((s) => s.selection.length);
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (open && projectId) void refreshAgent();
  }, [open, projectId]);

  // Follow the conversation unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries, running, open]);

  if (!open) return null;
  const last = entries[entries.length - 1];
  const thinking = running && (!last || last.kind === 'user' || (last.kind === 'tool' && last.status !== 'running'));
  const ready = Boolean(status?.ready);

  return (
    <div className="agent-panel" data-ui>
      <div className="agent-head">
        <Sparkles className="agent-logo" />
        <span className="agent-title">画布助手</span>
        {status?.model && <span className="agent-model">{status.model.split('/').pop()}</span>}
        <span className="agent-head-gap" />
        <button className="icon-btn small" title="新对话" onClick={() => void clear()} disabled={!entries.length}>
          <SquarePen />
        </button>
        <button className="icon-btn small" title="收起" onClick={() => toggleAgent(false)}>
          <X />
        </button>
      </div>

      <div
        className="agent-log"
        ref={log}
        data-scrollable
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!entries.length && (
          <div className="agent-empty">
            <Sparkles />
            <p>说说你想做什么，助手会在画布上出图、出视频，并把结果连到用到的节点上。</p>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="agent-suggest" onClick={() => useAgent.setState({ draft: s })}>
                {s}
              </button>
            ))}
          </div>
        )}
        {entries.map((e) => (
          <Entry key={e.id} entry={e} />
        ))}
        {thinking && (
          <div className="agent-thinking">
            <Loader2 className="spin" /> 思考中…
          </div>
        )}
      </div>

      {status && !ready && (
        <div className="agent-setup">
          <CircleAlert /> {status.reason}
        </div>
      )}

      <div className="agent-input">
        <textarea
          value={draft}
          rows={3}
          disabled={!ready}
          placeholder={selected ? `会带上选中的 ${selected} 个节点` : '想让助手做什么？'}
          onChange={(e) => useAgent.setState({ draft: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="agent-input-bar">
          <span className="agent-hint">{running ? '工作中，可以继续补充要求' : 'Enter 发送 · Shift+Enter 换行'}</span>
          {running && (
            <button className="btn ghost small" onClick={() => void stop()}>
              <Square /> 停止
            </button>
          )}
          <button className="btn primary small" disabled={!ready || !draft.trim()} onClick={() => void send()}>
            <ArrowUp /> 发送
          </button>
        </div>
      </div>
    </div>
  );
}

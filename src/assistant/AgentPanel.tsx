import { ArrowUp, Bell, CircleAlert, CircleCheck, Hourglass, Loader2, Sparkles, Square, SquarePen, StickyNote, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { thumbUrl } from '../../shared/media';
import type { AgentEntry, AgentEventData, AgentStatus, AgentUsage } from '../../shared/types';
import { ensureVisible, revealItems } from '../canvas/view';
import { api } from '../lib/api';
import { boundsOf, viewportCenter } from '../../shared/geometry';
import { redoneVersion } from '../../shared/frames';
import { savePending } from '../projects/sync';
import { select, toast, useStore } from '../store';
import { Markdown } from '../components/Markdown';
import { lang, t } from '../i18n';

const OPEN_KEY = 'infinode:agent';

/** Tools whose results are new board items worth bringing into view. */
const CREATES = new Set(['generate_image', 'generate_video', 'run_workflow']);

const SUGGESTIONS = [t('把选中的图各做一段 5 秒视频'), t('用选中的人物图，生成他在雨夜街头的三张不同景别的照片'), t('看看选中的图有没有问题，有问题就重新生成')];

interface AgentState {
  open: boolean;
  status: AgentStatus | null;
  /** Board the conversation belongs to. */
  projectId: string | null;
  entries: AgentEntry[];
  running: boolean;
  usage: AgentUsage;
  draft: string;
}

export const useAgent = create<AgentState>(() => ({
  open: localStorage.getItem(OPEN_KEY) === 'open',
  status: null,
  projectId: null,
  entries: [],
  running: false,
  usage: { tokens: 0, cost: 0 },
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
    useAgent.setState({ status, projectId, entries: view.entries, running: view.running, usage: view.usage });
  } catch (err) {
    useAgent.setState({ status: { ready: false, model: '', vision: false, reason: (err as Error).message }, projectId, entries: [], running: false, usage: { tokens: 0, cost: 0 } });
  }
}

export function onAgentEvent(e: AgentEventData) {
  const s = useAgent.getState();
  if (e.projectId !== s.projectId) return;
  if (e.reset) {
    useAgent.setState({ entries: [], running: false, usage: { tokens: 0, cost: 0 } });
    return;
  }
  const patch: Partial<AgentState> = {};
  if (e.running !== undefined) patch.running = e.running;
  if (e.usage) patch.usage = e.usage;
  const entry = e.entry;
  if (entry) {
    const i = s.entries.findIndex((x) => x.id === entry.id);
    patch.entries = i >= 0 ? s.entries.map((x, j) => (j === i ? entry : x)) : [...s.entries, entry];
    if (entry.kind === 'tool' && entry.status === 'done' && entry.items?.length && CREATES.has(entry.tool)) void revealItems(entry.items);
  }
  useAgent.setState(patch);
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
  if (!projectId || !confirm(running ? t('助手还在工作，停止并清空这段对话？') : t('清空这段对话？画布上的内容不受影响。'))) return;
  await api.clearAgent(projectId).catch((err) => toast((err as Error).message, 'error'));
}

function focusItems(ids: string[]) {
  const items = useStore.getState().items.filter((i) => ids.includes(i.id));
  const bounds = boundsOf(items);
  if (!bounds) return toast(t('这些节点已经不在画布上了'), 'info');
  select(items.map((i) => i.id));
  ensureVisible(bounds);
}

function ItemChip({ id }: { id: string }) {
  const item = useStore((s) => s.items.find((i) => i.id === id));
  if (!item) return <span className="agent-chip gone" title={t('已不在画布上')} />;
  const media = item.asset;
  return (
    <button className="agent-chip" title={item.name ?? t('在画布上查看')} onClick={() => focusItems([id])}>
      {media ? (
        <img src={thumbUrl(media.url)} alt="" />
      ) : item.kind === 'text' ? (
        <StickyNote />
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
        {entry.text && <Markdown text={entry.text} className="agent-text" />}
        {entry.error && (
          <div className="agent-error">
            <CircleAlert /> {entry.error}
          </div>
        )}
      </div>
    );
  }
  if (entry.kind === 'event') {
    return (
      <div className="agent-event">
        <Bell /> <span>{entry.text}</span>
      </div>
    );
  }
  return (
    <div className={`agent-tool ${entry.status}`}>
      <span className="agent-tool-icon">
        {entry.status === 'running' ? (
          <Loader2 className="spin" />
        ) : entry.status === 'done' ? (
          <CircleCheck />
        ) : entry.status === 'waiting' ? (
          <Hourglass />
        ) : (
          <CircleAlert />
        )}
      </span>
      <div className="agent-tool-main">
        <div className="agent-tool-line" title={entry.summary}>
          <b>{entry.label}</b>
          {entry.summary && <span>{entry.summary}</span>}
        </div>
        {entry.items && <Chips ids={entry.items} />}
        {entry.status === 'waiting' && entry.approval && <Approval id={entry.id} approval={entry.approval} />}
      </div>
    </div>
  );
}

/** Work the agent holds until the user agrees, e.g. a batch of long video generations. */
function Approval({ id, approval }: { id: string; approval: NonNullable<Extract<AgentEntry, { kind: 'tool' }>['approval']> }) {
  const [busy, setBusy] = useState(false);
  const items = useStore((s) => s.items);
  // What will be submitted: a keyframe redone after the card was made replaces its old version.
  const frames = approval.frames?.map((id) => {
    const frame = items.find((i) => i.id === id);
    return (frame && approval.since !== undefined ? redoneVersion(items, frame, approval.since, (i) => Boolean(i.asset))?.id : undefined) ?? id;
  });
  const redone = frames?.filter((f, i) => f !== approval.frames![i]).length ?? 0;
  const answer = async (ok: boolean) => {
    const { projectId } = useAgent.getState();
    if (!projectId) return;
    setBusy(true);
    try {
      await api.approveAgent(projectId, id, ok);
    } catch (err) {
      toast((err as Error).message, 'error');
      setBusy(false);
    }
  };
  return (
    <div className="agent-approval">
      <b>{approval.title}</b>
      <span>{approval.detail}</span>
      {frames && <Chips ids={frames} />}
      {redone > 0 && <span>{t('{n} 段的首帧用的是确认卡之后重做的版本', { n: redone })}</span>}
      <div className="agent-approval-bar">
        <button className="btn ghost small" disabled={busy} onClick={() => void answer(false)}>
          {t('不要')}
        </button>
        <button className="btn primary small" disabled={busy} onClick={() => void answer(true)}>
          {approval.confirm ?? t('开始')}
        </button>
      </div>
    </div>
  );
}

export function AgentButton() {
  const open = useAgent((s) => s.open);
  const running = useAgent((s) => s.running);
  return (
    <button className={`pill ${open ? 'on' : ''} ${running ? 'busy' : ''}`} onClick={() => toggleAgent()} title={t('画布助手：说一句话，让它在画布上出图、出视频')}>
      {running ? <Loader2 className="spin" /> : <Sparkles />} {t('助手')}
    </button>
  );
}

const compact = new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'en', { notation: 'compact', maximumFractionDigits: 1 });

/** Costs come in US dollars (model list prices); the Chinese interface shows yuan at this rough fixed rate. */
const CNY_PER_USD = 7.2;

/** "1.2万 tokens · ¥0.022" / "12.3K tokens · $0.003" */
function usageText(u: AgentUsage): string {
  const tokens = compact.format(u.tokens);
  if (!(u.cost > 0)) return `${tokens} tokens`;
  const cost = lang === 'zh' ? u.cost * CNY_PER_USD : u.cost;
  return `${tokens} tokens · ${lang === 'zh' ? '¥' : '$'}${cost.toFixed(cost < 0.1 ? 3 : 2)}`;
}

export function AgentPanel() {
  const { open, status, entries, running, usage, draft } = useAgent();
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
  const thinking = running && (!last || last.kind === 'user' || last.kind === 'event' || (last.kind === 'tool' && last.status !== 'running'));
  const ready = Boolean(status?.ready);

  return (
    <div className="agent-panel" data-ui>
      <div className="agent-head">
        <Sparkles className="agent-logo" />
        <span className="agent-title">{t('画布助手')}</span>
        {status?.model && <span className="agent-model">{status.model.split('/').pop()}</span>}
        <span className="agent-head-gap" />
        {usage.tokens > 0 && (
          <span
            className="agent-usage"
            title={
              lang === 'zh'
                ? t('这段对话用掉的 tokens 和费用。tokens 不算命中缓存的部分，那部分几乎不花钱；费用按模型的公开价格估算，美元按 1:{rate} 换成人民币，以服务商账单为准', { rate: CNY_PER_USD })
                : t('这段对话用掉的 tokens 和费用。tokens 不算命中缓存的部分，那部分几乎不花钱；费用按模型的公开价格估算，以服务商账单为准')
            }
          >
            {usageText(usage)}
          </span>
        )}
        <button className="icon-btn small" title={t('新对话')} onClick={() => void clear()} disabled={!entries.length}>
          <SquarePen />
        </button>
        <button className="icon-btn small" title={t('收起')} onClick={() => toggleAgent(false)}>
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
            <p>{t('说说你想做什么，助手会在画布上出图、出视频，并把结果连到用到的节点上。')}</p>
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
            <Loader2 className="spin" /> {t('思考中…')}
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
          placeholder={selected ? t('会带上选中的 {n} 个节点', { n: selected }) : t('想让助手做什么？')}
          onChange={(e) => useAgent.setState({ draft: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="agent-input-bar">
          <span className="agent-hint">{running ? t('工作中，可以继续补充要求') : t('Enter 发送 · Shift+Enter 换行')}</span>
          {running && (
            <button className="btn ghost small" onClick={() => void stop()}>
              <Square /> {t('停止')}
            </button>
          )}
          <button className="btn primary small" disabled={!ready || !draft.trim()} onClick={() => void send()}>
            <ArrowUp /> {t('发送')}
          </button>
        </div>
      </div>
    </div>
  );
}

import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type AgentMemories, type AgentMemory, ENTRY_CHARS, MEMORY_LIMIT, MEMORY_TYPES, type MemoryEntry, type MemoryScope, type MemoryType } from '../../shared/types';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { toast } from '../store';
import { t } from '../i18n';

const TYPE_LABEL: Record<MemoryType, string> = { setting: t('设定'), decision: t('决定'), preference: t('偏好'), feedback: t('纠正') };
const SCOPE_TITLE: Record<MemoryScope, string> = { board: t('这块画布'), user: t('所有画布（我的偏好）') };
const SCOPE_HELP: Record<MemoryScope, string> = {
  board: t('人物、画风、定下来的事。只在这块画布的对话里用。'),
  user: t('你的长期偏好和纠正过的做法。每块画布的对话都会用。'),
};

const size = (entries: MemoryEntry[]) => entries.reduce((n, e) => n + e.text.trim().length + (e.why?.trim().length ?? 0), 0);
const when = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * What the assistant remembers across conversations, both scopes: read, edit, delete, add, and whether it
 * may write there on its own. The assistant reads the edit with the next message.
 */
export function MemoryModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [memory, setMemory] = useState<AgentMemories | null>(null);
  const [saved, setSaved] = useState<AgentMemories | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .agentMemory(projectId)
      .then((m) => {
        setMemory(m);
        setSaved(m);
      })
      .catch((err) => {
        toast((err as Error).message, 'error');
        onClose();
      });
  }, [projectId, onClose]);

  const change = (scope: MemoryScope, next: Partial<AgentMemory>) => setMemory((m) => m && { ...m, [scope]: { ...m[scope], ...next } });
  const edit = (scope: MemoryScope, i: number, patch: Partial<MemoryEntry>) =>
    memory && change(scope, { entries: memory[scope].entries.map((e, j) => (j === i ? { ...e, ...patch } : e)) });
  const save = async () => {
    if (!memory || !saved) return;
    setBusy(true);
    try {
      for (const scope of ['board', 'user'] as const) {
        if (JSON.stringify(memory[scope]) === JSON.stringify(saved[scope])) continue;
        await api.saveAgentMemory(projectId, scope, memory[scope]);
      }
      toast(t('记忆已保存，助手下一条消息就会用上'), 'success');
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('记忆')}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            {t('取消')}
          </button>
          <button className="btn primary" disabled={!memory || busy} onClick={() => void save()}>
            {t('保存')}
          </button>
        </>
      }
    >
      <p className="m-help">{t('助手会把值得长期记住的事写在这里，换一段对话、整理成摘要之后也还记得。画布上已有的剧本和分镜不会记在这里。')}</p>
      {memory &&
        (['board', 'user'] as const).map((scope) => {
          const m = memory[scope];
          const used = size(m.entries);
          return (
            <section key={scope} className="m-section agent-memory">
              <div className="agent-memory-head">
                <b>{SCOPE_TITLE[scope]}</b>
                <span className={`agent-memory-size ${used > MEMORY_LIMIT[scope] ? 'over' : ''}`}>{t('{used}/{limit} 字', { used, limit: MEMORY_LIMIT[scope] })}</span>
                <label className="m-check">
                  <input type="checkbox" checked={m.auto} onChange={(e) => change(scope, { auto: e.target.checked })} />
                  <span>{t('让助手自动记')}</span>
                </label>
              </div>
              <div className="m-help">{SCOPE_HELP[scope]}</div>
              {!m.entries.length && <div className="agent-memory-empty">{t('还没有记下任何东西')}</div>}
              {m.entries.map((e, i) => (
                <div key={e.id || i} className="agent-memory-entry">
                  <div className="agent-memory-row">
                    <select value={e.type} onChange={(ev) => edit(scope, i, { type: ev.target.value as MemoryType })}>
                      {MEMORY_TYPES[scope].map((type) => (
                        <option key={type} value={type}>
                          {TYPE_LABEL[type]}
                        </option>
                      ))}
                    </select>
                    <span className="agent-memory-meta">{e.at ? `${e.by === 'user' ? t('你写的') : t('助手记的')} · ${when(e.at)}` : t('新的')}</span>
                    <button className="icon-btn small" title={t('删除')} onClick={() => change(scope, { entries: m.entries.filter((_, j) => j !== i) })}>
                      <Trash2 />
                    </button>
                  </div>
                  <textarea value={e.text} rows={2} maxLength={ENTRY_CHARS} placeholder={t('记什么，一句话')} onChange={(ev) => edit(scope, i, { text: ev.target.value })} />
                  <input value={e.why ?? ''} maxLength={ENTRY_CHARS} placeholder={t('原因（可选）')} onChange={(ev) => edit(scope, i, { why: ev.target.value })} />
                </div>
              ))}
              <button
                className="btn ghost small"
                onClick={() => change(scope, { entries: [...m.entries, { id: '', type: MEMORY_TYPES[scope][0], text: '', at: 0, by: 'user' }] })}
              >
                <Plus /> {t('添加一条')}
              </button>
            </section>
          );
        })}
    </Modal>
  );
}

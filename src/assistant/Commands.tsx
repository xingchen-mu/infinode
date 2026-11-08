import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BUILTIN_COMMANDS, type BuiltinCommand, COMMAND_SLOT } from '../../shared/commands';
import type { AgentCommand } from '../../shared/types';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { toast } from '../store';
import { lang, t } from '../i18n';

export interface SlashItem {
  name: string;
  description: string;
}

/** The token a saved command's prompt uses for the text typed after it. */
const SLOT = COMMAND_SLOT[lang];

const BUILTIN_TEXT: Record<BuiltinCommand, string> = {
  plan: t('切换计划模式；后面跟一句话就打开计划模式并发出去'),
  condense: t('把较早的对话整理成摘要；后面可以写重点保留什么'),
  new: t('开始新对话'),
};

/**
 * Commands matching what is typed, while the input holds just "/" and part of a name; null otherwise.
 * Built-ins match by either of their names.
 */
export function slashItems(draft: string, commands: AgentCommand[]): SlashItem[] | null {
  const m = /^\/([^\s/]*)$/.exec(draft);
  if (!m) return null;
  const typed = m[1].toLowerCase();
  const builtins = (Object.keys(BUILTIN_COMMANDS) as BuiltinCommand[])
    .filter((k) => BUILTIN_COMMANDS[k].some((n) => n.toLowerCase().startsWith(typed)))
    .map((k) => ({ name: BUILTIN_COMMANDS[k][lang === 'zh' ? 0 : 1], description: BUILTIN_TEXT[k] }));
  const own = commands
    .filter((c) => c.name.toLowerCase().startsWith(typed))
    .map((c) => ({ name: c.name, description: c.prompt.replace(/\s+/g, ' ').slice(0, 60) }));
  return [...builtins, ...own];
}

/** The list above the input while a /command is being typed; the last row opens the saved commands. */
export function SlashMenu({ items, active, onPick, onHover, onManage }: { items: SlashItem[]; active: number; onPick: (item: SlashItem) => void; onHover: (i: number) => void; onManage: () => void }) {
  return (
    <div className="agent-slash" role="listbox">
      {!items.length && <div className="agent-slash-empty">{t('没有这个命令')}</div>}
      {items.map((it, i) => (
        <button
          key={it.name}
          role="option"
          aria-selected={i === active}
          className={`agent-slash-item ${i === active ? 'on' : ''}`}
          onMouseEnter={() => onHover(i)}
          // Keeps the focus in the input.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(it)}
        >
          <b>/{it.name}</b>
          <span>{it.description}</span>
        </button>
      ))}
      <button className="agent-slash-item manage" onMouseDown={(e) => e.preventDefault()} onClick={onManage}>
        {t('管理我的命令…')}
      </button>
    </div>
  );
}

/** The user's saved commands: a name, and the prompt it sends. */
export function CommandsModal({ onClose, onSaved }: { onClose: () => void; onSaved: (list: AgentCommand[]) => void }) {
  const [list, setList] = useState<AgentCommand[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .agentCommands()
      .then(setList)
      .catch((err) => {
        toast((err as Error).message, 'error');
        setList([]);
      });
  }, []);
  const edit = (i: number, patch: Partial<AgentCommand>) => setList((l) => l && l.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const save = async () => {
    if (!list) return;
    setBusy(true);
    try {
      const saved = await api.saveAgentCommands(list.filter((c) => c.name.trim() || c.prompt.trim()));
      onSaved(saved);
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t('我的命令')}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            {t('取消')}
          </button>
          <button className="btn primary" disabled={!list || busy} onClick={() => void save()}>
            {t('保存')}
          </button>
        </>
      }
    >
      <p className="m-help">{t('在助手的输入框里打 /命令名 就能用。内容里写 {slot}，会换成命令后面的文字；不写就接在最后。', { slot: SLOT })}</p>
      {list?.map((c, i) => (
        <div className="agent-cmd" key={i}>
          <div className="agent-cmd-name">
            <span>/</span>
            <input value={c.name} maxLength={20} placeholder={t('命令名')} onChange={(e) => edit(i, { name: e.target.value.replace(/[\s/]/g, '') })} />
            <button className="icon-btn small" title={t('删除')} onClick={() => setList((l) => l && l.filter((_, j) => j !== i))}>
              <Trash2 />
            </button>
          </div>
          <textarea
            value={c.prompt}
            rows={3}
            maxLength={4000}
            placeholder={t('比如：做一部三个镜头的短剧，故事是：{slot}', { slot: SLOT })}
            onChange={(e) => edit(i, { prompt: e.target.value })}
          />
        </div>
      ))}
      <button className="btn ghost small" disabled={!list} onClick={() => setList((l) => [...(l ?? []), { name: '', prompt: '' }])}>
        <Plus /> {t('新命令')}
      </button>
    </Modal>
  );
}

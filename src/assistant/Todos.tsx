import { ChevronDown, ChevronRight, Circle, CircleCheck, CircleDot } from 'lucide-react';
import { useState } from 'react';
import type { AgentTodo } from '../../shared/types';
import { t } from '../i18n';

/** The assistant's to-do list for a long task, above the conversation; folded once everything is done. */
export function Todos({ todos }: { todos: AgentTodo[] }) {
  const done = todos.filter((x) => x.status === 'completed').length;
  const finished = done === todos.length;
  // null: follow the list (open while there is work left); true / false: the user's choice.
  const [opened, setOpened] = useState<boolean | null>(null);
  if (!todos.length) return null;
  const open = opened ?? !finished;
  const now = todos.find((x) => x.status === 'in_progress');
  return (
    <div className={`agent-todos ${finished ? 'finished' : ''}`}>
      <button className="agent-todos-head" onClick={() => setOpened(!open)}>
        {open ? <ChevronDown /> : <ChevronRight />}
        <b>{finished ? t('待办全部完成') : t('待办')}</b>
        <span className="agent-todos-count">{t('{done}/{total} 完成', { done, total: todos.length })}</span>
        {!open && now && <span className="agent-todos-now">{now.content}</span>}
      </button>
      {open && (
        <ul>
          {todos.map((x, i) => (
            <li key={i} className={x.status}>
              {x.status === 'completed' ? <CircleCheck /> : x.status === 'in_progress' ? <CircleDot /> : <Circle />}
              <span>{x.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

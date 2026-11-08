import { ArrowUp } from 'lucide-react';
import { useState } from 'react';
import type { AgentQuestion } from '../../shared/types';
import { listSeparator } from '../../shared/i18n';
import { lang, list, t } from '../i18n';

/**
 * What the assistant asked, with its options: one click answers (or, for several, ticks and Confirm), and
 * the user may write their own answer. Answered and skipped questions show how they ended.
 */
export function QuestionCard({ question, onAnswer }: { question: AgentQuestion; onAnswer: (answer: string) => Promise<void> }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [own, setOwn] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = question.state !== 'answered';
  const answer = async (text: string) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onAnswer(text.trim());
    } finally {
      setBusy(false);
    }
  };
  const toggle = (label: string) => setPicked((p) => (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]));
  return (
    <div className={`agent-question ${question.state}`}>
      <b>{question.text}</b>
      <div className="agent-question-options">
        {question.options.map((o) => {
          const chosen = question.state === 'answered' ? question.answer?.split(listSeparator(lang)).includes(o.label) : picked.includes(o.label);
          return (
            <button
              key={o.label}
              className={`agent-option ${chosen ? 'on' : ''}`}
              disabled={!pending || busy}
              title={o.description}
              onClick={() => (question.multiple ? toggle(o.label) : void answer(o.label))}
            >
              <span>{o.label}</span>
              {o.description && <small>{o.description}</small>}
            </button>
          );
        })}
      </div>
      {pending && (
        <div className="agent-question-bar">
          <input
            value={own}
            disabled={busy}
            maxLength={2000}
            placeholder={question.multiple ? t('或者自己写') : t('都不合适？自己写')}
            onChange={(e) => setOwn(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void answer(own);
            }}
          />
          {question.multiple ? (
            <button className="btn primary small" disabled={busy || (!picked.length && !own.trim())} onClick={() => void answer(list([...picked, own.trim()].filter(Boolean)))}>
              {t('确定')}
            </button>
          ) : (
            <button className="btn primary small" disabled={busy || !own.trim()} onClick={() => void answer(own)} title={t('发送')}>
              <ArrowUp />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

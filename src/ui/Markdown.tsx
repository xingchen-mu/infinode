import { Fragment, type ReactNode } from 'react';

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

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

/** The bits of Markdown models use most: headings, lists, tables, bold, code. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
        if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i])) rows.push(cells(lines[i]));
      }
      i--;
      const [head, ...body] = rows;
      out.push(
        <table key={i}>
          <thead>
            <tr>{head?.map((c, k) => <th key={k}>{inline(c)}</th>)}</tr>
          </thead>
          <tbody>
            {body.map((r, n) => (
              <tr key={n}>{r.map((c, k) => <td key={k}>{inline(c)}</td>)}</tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (heading) out.push(<p key={i} className="h">{inline(heading[1])}</p>);
    else if (bullet) out.push(<p key={i} className="li">• {inline(bullet[1])}</p>);
    else if (/^\s*\d+[.、)]\s+/.test(line)) out.push(<p key={i} className="li">{inline(line.trim())}</p>);
    else out.push(line.trim() ? <p key={i}>{inline(line)}</p> : <p key={i} className="gap" />);
  }
  return <div className={`md ${className ?? ''}`}>{out}</div>;
}

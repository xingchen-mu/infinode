// Finds translation keys and stray Chinese text in source files, for test/i18n.test.ts.
// A small tokenizer is enough here: it tells strings, template text, regexes and comments from code.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const CJK = /[　-〿一-鿿＀-￯]/;

interface Str {
  start: number;
  end: number;
  value: string;
  /** Text between `${}` in a template literal. */
  template: boolean;
}

/** The source with strings, regexes and comments blanked out (same offsets), and the strings found. */
export function tokenize(src: string): { code: string; strings: Str[] } {
  const strings: Str[] = [];
  const code = src.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (code[k] !== '\n') code[k] = ' ';
  };
  let i = 0;
  const prevSignificant = (at: number) => {
    let k = at - 1;
    while (k >= 0 && /\s/.test(code[k])) k--;
    return k < 0 ? '' : code[k];
  };
  const readQuoted = (q: string) => {
    const start = i;
    let value = '';
    i++;
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') {
        const n = src[i + 1];
        value += n === 'n' ? '\n' : n === 't' ? '\t' : n;
        i += 2;
      } else value += src[i++];
    }
    i++;
    strings.push({ start, end: i, value, template: false });
    blank(start + 1, i - 1);
  };
  const readTemplate = () => {
    i++; // `
    let partStart = i;
    let value = '';
    const flush = () => {
      if (value) strings.push({ start: partStart, end: i, value, template: true });
      blank(partStart, i);
      value = '';
    };
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') {
        value += src[i + 1];
        i += 2;
      } else if (src[i] === '$' && src[i + 1] === '{') {
        flush();
        i += 2;
        readCode('}');
        i++; // }
        partStart = i;
      } else value += src[i++];
    }
    flush();
    i++;
  };
  const readCode = (until?: string) => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (until && depth === 0 && c === until) return;
      if (c === '{') depth++;
      else if (c === '}') depth--;
      if (c === '/' && src[i + 1] === '/') {
        const end = src.indexOf('\n', i);
        blank(i, end < 0 ? src.length : end);
        i = end < 0 ? src.length : end;
      } else if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2) + 2;
        blank(i, end);
        i = end;
      } else if (c === "'" || c === '"') readQuoted(c);
      else if (c === '`') readTemplate();
      else if (c === '/' && /^$|[(,=:[!&|?{;]/.test(prevSignificant(i))) {
        // A regex literal.
        const start = i++;
        let inClass = false;
        while (i < src.length && (src[i] !== '/' || inClass)) {
          if (src[i] === '\\') i++;
          else if (src[i] === '[') inClass = true;
          else if (src[i] === ']') inClass = false;
          i++;
        }
        i++;
        while (/[a-z]/i.test(src[i] ?? '')) i++;
        blank(start, i);
      } else i++;
    }
  };
  readCode();
  return { code: code.join(''), strings };
}

export interface Scan {
  /** Strings given to t() or msg(). */
  keys: Set<string>;
  /** Chinese text that is not a key, "file:line text". */
  stray: string[];
}

/** Keys used in a file, and (when `strict`) Chinese text in it that does not go through t()/msg(). */
export function scanFile(path: string, strict: boolean): Scan {
  const src = readFileSync(path, 'utf8');
  const { code, strings } = tokenize(src);
  const keys = new Set<string>();
  const inKey = new Set<Str>();
  for (const m of code.matchAll(/\b(t|msg)\(/g)) {
    // The first argument runs to the first top-level comma or closing parenthesis.
    let depth = 0;
    let k = m.index + m[0].length;
    for (; k < code.length; k++) {
      const c = code[k];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) break;
    }
    for (const s of strings) {
      if (s.start >= m.index && s.end <= k && !s.template) {
        keys.add(s.value);
        inKey.add(s);
      }
    }
  }
  const stray: string[] = [];
  if (strict) {
    const line = (at: number) => src.slice(0, at).split('\n').length;
    for (const s of strings) if (!inKey.has(s) && CJK.test(s.value)) stray.push(`${path}:${line(s.start)} ${s.value.slice(0, 50)}`);
    code.split('\n').forEach((l, n) => CJK.test(l) && stray.push(`${path}:${n + 1} ${l.trim().slice(0, 50)}`));
  }
  return { keys, stray };
}

export function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

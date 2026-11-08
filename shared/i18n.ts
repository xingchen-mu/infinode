// Interface languages. Chinese text in the code is the message key; other languages are dictionaries keyed by
// that text (shared/locales). A key missing from a dictionary shows the Chinese, and test/i18n.test.ts makes
// sure none are missing. Names that come from data (template names, detected input labels) are stored in
// Chinese and translated where they are shown, so a name the user typed passes through unchanged.

import { EN } from './locales/en.ts';

export type Lang = 'zh' | 'en';
export const LANGS: { id: Lang; name: string }[] = [
  { id: 'zh', name: '中文' },
  { id: 'en', name: 'English' },
];

/** A translation; a pair is [singular, plural], picked by the `n` variable. */
export type Translation = string | [string, string];
export type Vars = Record<string, string | number>;
export type Translate = (zh: string, vars?: Vars) => string;

const DICTS: Record<Lang, Record<string, Translation>> = { zh: {}, en: EN };

/** Marks Chinese text for translation where it is defined; `t` translates it where it is shown. */
export const msg = (zh: string) => zh;

export function translate(lang: Lang, zh: string, vars?: Vars): string {
  let s = DICTS[lang][zh] ?? labelWithNumber(lang, zh) ?? zh;
  if (Array.isArray(s)) s = vars?.n === 1 ? s[0] : s[1];
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** "参考图2" → "Reference 2": numbered input labels made from a translatable base. */
function labelWithNumber(lang: Lang, zh: string): string | undefined {
  const m = /^(\D+?)\s*(\d+)$/.exec(zh);
  const base = m && DICTS[lang][m[1]];
  return typeof base === 'string' ? `${base} ${m![2]}` : undefined;
}

export const isLang = (v: unknown): v is Lang => v === 'zh' || v === 'en';

/** What joins a list: "、" / ", ". */
export const listSeparator = (lang: Lang) => (lang === 'zh' ? '、' : ', ');

/** "a、b、c" / "a, b, c". */
export const joinList = (lang: Lang, xs: string[]) => xs.join(listSeparator(lang));

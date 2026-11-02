import { Fragment, type ReactNode, createElement } from 'react';
import { type Lang, type Vars, isLang, joinList, translate } from '../shared/i18n';

const KEY = 'infinode:lang';

/** The page's language, fixed for the life of the page: switching saves it and reloads. */
export const lang: Lang = (() => {
  const saved = localStorage.getItem(KEY);
  if (isLang(saved)) return saved;
  return /^zh\b/i.test(navigator.language) ? 'zh' : 'en';
})();
document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';

export const t = (zh: string, vars?: Vars) => translate(lang, zh, vars);
export const list = (xs: string[]) => joinList(lang, xs);

/** A translated sentence with elements in it: "{0}" … in the text are replaced by `parts[0]` …. */
export function rich(text: string, parts: ReactNode[]): ReactNode[] {
  return text.split(/\{(\d+)\}/).map((s, i) => createElement(Fragment, { key: i }, i % 2 ? parts[Number(s)] : s));
}

export function rememberLang(next: Lang) {
  localStorage.setItem(KEY, next);
}

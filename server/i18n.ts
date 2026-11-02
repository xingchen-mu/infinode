import { type Lang, type Vars, joinList, translate } from '../shared/i18n.ts';

// The server speaks the language of the page that last opened it (Settings.language): its error messages,
// task stages and the assistant's panel rows and replies.
let current: Lang = 'zh';

export const serverLang = () => current;
export function setServerLang(lang: Lang) {
  current = lang;
}

export const t = (zh: string, vars?: Vars) => translate(current, zh, vars);
export const list = (xs: string[]) => joinList(current, xs);

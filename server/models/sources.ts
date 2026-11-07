import type { Lang } from '../../shared/i18n.ts';
import type { ModelSource } from '../../shared/types.ts';

// Model links point at huggingface.co. Mirrors such as hf-mirror.com serve the same paths
// (/<repo>/resolve/<revision>/<file>), so a link moves to another endpoint by swapping its origin.

export const OFFICIAL = 'https://huggingface.co';
export const MIRROR = 'https://hf-mirror.com';

const HF_HOSTS = new Set(['huggingface.co', 'www.huggingface.co', 'hf.co']);

export interface Candidate {
  url: string;
  /** Send the Hugging Face token with this request. */
  auth: boolean;
}

export function isHuggingFace(url: string): boolean {
  try {
    return HF_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** The same file on another Hugging Face compatible endpoint (which may have a path, e.g. https://host/hf). */
export function onEndpoint(url: string, endpoint: string): string {
  const u = new URL(url);
  const e = new URL(endpoint);
  return `${e.origin}${e.pathname.replace(/\/+$/, '')}${u.pathname}${u.search}`;
}

/** "hf-mirror.com/" → "https://hf-mirror.com"; only http(s). */
export function normalizeEndpoint(input: string): string {
  let s = input.trim();
  if (/^[a-z][\w+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) throw new Error('http(s) only');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('http(s) only');
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

/**
 * URLs to try for a model link, in order. 'auto' tries hf-mirror.com first for Chinese users (huggingface.co
 * is often unreachable there) and huggingface.co first otherwise, starting with whichever answered last time.
 * In 'auto' the token only goes to huggingface.co; a mirror gets it only when the user picked that mirror.
 */
export function candidates(url: string, source: { source: ModelSource; endpoint?: string }, lang: Lang, preferred?: string): Candidate[] {
  if (!isHuggingFace(url)) return [{ url, auth: false }];
  switch (source.source) {
    case 'huggingface':
      return [{ url: onEndpoint(url, OFFICIAL), auth: true }];
    case 'hf-mirror':
      return [{ url: onEndpoint(url, MIRROR), auth: true }];
    case 'custom':
      return [{ url: onEndpoint(url, source.endpoint || OFFICIAL), auth: true }];
    default: {
      let order = lang === 'zh' ? [MIRROR, OFFICIAL] : [OFFICIAL, MIRROR];
      if (preferred && order.includes(preferred)) order = [preferred, ...order.filter((e) => e !== preferred)];
      return order.map((e) => ({ url: onEndpoint(url, e), auth: e === OFFICIAL }));
    }
  }
}

/** The endpoint ('auto' remembers it) a candidate URL belongs to. */
export function endpointOf(url: string): string | undefined {
  try {
    const origin = new URL(url).origin;
    return [OFFICIAL, MIRROR].find((e) => e === origin);
  } catch {
    return undefined;
  }
}

export const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

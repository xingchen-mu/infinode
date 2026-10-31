import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Settings } from '../shared/types.ts';
import { config } from './config.ts';

/** Settings changed in the app (data/settings.json); .env only supplies the defaults. */
export class SettingsStore {
  private readonly file = join(config.dataDir, 'settings.json');
  value: Settings = { comfyUrl: config.comfyUrl };

  async init() {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as Partial<Settings>;
      if (typeof saved.comfyUrl === 'string' && saved.comfyUrl) this.value.comfyUrl = saved.comfyUrl;
    } catch {
      /* defaults */
    }
  }

  async save(patch: Partial<Settings>) {
    this.value = { ...this.value, ...patch };
    await writeFile(`${this.file}.tmp`, JSON.stringify(this.value, null, 1));
    await rename(`${this.file}.tmp`, this.file);
    return this.value;
  }
}

/** "localhost:8188" → "http://localhost:8188"; rejects anything that is not http(s). */
export function normalizeComfyUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http / https 地址');
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

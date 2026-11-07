import type { ModelDownload } from '../../shared/types.ts';
import type { ModelSlot } from '../workflows/models.ts';

// The model files Infinode knows how to download: every file the official templates list. The built-in tools
// use the same files, so their slots look their downloads up here instead of keeping a second list of links.

/** Only formats that cannot run code when ComfyUI loads them (unlike pickled .ckpt / .pt). */
const MODEL_FILE = /\.(safetensors|sft|gguf)$/i;
const SEGMENT = /^[\w.+\-() [\]]+$/;

/** A file name (may contain subfolders) and models folder that stay inside that folder. */
export function safeModelPath(directory: string, name: string): boolean {
  if (!/^[\w.-]+$/.test(directory) || directory.startsWith('.')) return false;
  const parts = name.split('/');
  return MODEL_FILE.test(name) && parts.every((p) => p !== '.' && p !== '..' && SEGMENT.test(p) && !p.startsWith('-'));
}

/** Downloadable files by name; the first list that has a name wins. */
export function buildCatalog(lists: ModelDownload[][]): Map<string, ModelDownload> {
  const out = new Map<string, ModelDownload>();
  for (const list of lists) {
    for (const m of list) {
      if (!m.url || !m.directory || out.has(m.name) || !safeModelPath(m.directory, m.name)) continue;
      if (!/^https:\/\//.test(m.url)) continue;
      out.set(m.name, { name: m.name, url: m.url, directory: m.directory });
    }
  }
  return out;
}

/** The download for a built-in tool's model slot: its first candidate file that has one. */
export function slotDownload(slot: ModelSlot, catalog: Map<string, ModelDownload>): ModelDownload | undefined {
  for (const name of slot.candidates) {
    const m = catalog.get(name);
    if (m) return m;
  }
  return undefined;
}

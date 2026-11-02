import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { imageSize } from 'image-size';
import { nanoid } from 'nanoid';
import type { AssetInfo, MediaKind } from '../shared/types.ts';
import { config } from './config.ts';
import { t } from './i18n.ts';

export interface StoredAsset extends AssetInfo {
  file: string;
  hasAlpha?: boolean;
  /** Name of the copy in ComfyUI's input folder, once uploaded. */
  comfyName?: string;
  createdAt: number;
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

const EXT_BY_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext]),
);

export function mimeFor(filename: string): string | undefined {
  return MIME_BY_EXT[extname(filename).toLowerCase()];
}

/** PNG color types 4 and 6 carry alpha; a tRNS chunk adds it to the others. */
function pngHasAlpha(data: Uint8Array): boolean {
  if (data.length < 33 || data[0] !== 0x89 || data[1] !== 0x50) return false;
  if (data[25] === 4 || data[25] === 6) return true;
  const head = Buffer.from(data.buffer, data.byteOffset, Math.min(data.length, 65536));
  return head.includes('tRNS');
}

export class AssetStore {
  readonly dir = join(config.dataDir, 'assets');
  private readonly indexFile = join(config.dataDir, 'assets.json');
  private assets = new Map<string, StoredAsset>();
  private saveTimer?: NodeJS.Timeout;

  async init() {
    await mkdir(this.dir, { recursive: true });
    try {
      const list = JSON.parse(await readFile(this.indexFile, 'utf8')) as StoredAsset[];
      for (const a of list) this.assets.set(a.id, a);
    } catch {
      /* first run */
    }
  }

  get(id: string): StoredAsset | undefined {
    return this.assets.get(id);
  }

  path(asset: StoredAsset) {
    return join(this.dir, asset.file);
  }

  read(asset: StoredAsset) {
    return readFile(this.path(asset));
  }

  /**
   * Stores a file. Images are measured here; videos need `size` (the browser
   * corrects it after loading metadata if it is off).
   */
  async save(
    data: Uint8Array,
    opts: { filename?: string; mime?: string; size?: { width: number; height: number }; name?: string; comfyName?: string },
  ): Promise<StoredAsset> {
    const mime = opts.mime || (opts.filename ? mimeFor(opts.filename) : undefined);
    if (!mime || !EXT_BY_MIME[mime]) throw new Error(t('不支持的文件类型: {name}', { name: opts.filename ?? mime ?? 'unknown' }));
    const kind: MediaKind = mime.startsWith('video/') ? 'video' : 'image';
    let width = opts.size?.width ?? 0;
    let height = opts.size?.height ?? 0;
    if (kind === 'image') {
      const dim = imageSize(data);
      width = dim.width;
      height = dim.height;
      // EXIF rotations 5-8 swap the displayed axes.
      if (dim.orientation && dim.orientation >= 5) [width, height] = [height, width];
    }
    const id = nanoid(12);
    const file = id + EXT_BY_MIME[mime];
    const tmp = join(this.dir, `.${file}.tmp`);
    await writeFile(tmp, data);
    await rename(tmp, join(this.dir, file));
    const asset: StoredAsset = {
      id,
      file,
      url: `/files/${file}`,
      kind,
      mime,
      width,
      height,
      name: opts.name,
      hasAlpha: mime === 'image/png' ? pngHasAlpha(data) : undefined,
      comfyName: opts.comfyName,
      createdAt: Date.now(),
    };
    this.assets.set(id, asset);
    this.scheduleSave();
    return asset;
  }

  /** After switching ComfyUI servers, nothing uploaded to the old one can be reused. */
  forgetComfyNames() {
    for (const a of this.assets.values()) delete a.comfyName;
    this.scheduleSave();
  }

  setComfyName(id: string, comfyName: string) {
    const a = this.assets.get(id);
    if (!a) return;
    a.comfyName = comfyName;
    this.scheduleSave();
  }

  updateSize(id: string, width: number, height: number) {
    const a = this.assets.get(id);
    if (!a || !(width > 0 && height > 0)) return;
    a.width = Math.round(width);
    a.height = Math.round(height);
    this.scheduleSave();
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 300);
  }

  async flush() {
    clearTimeout(this.saveTimer);
    const tmp = this.indexFile + '.tmp';
    await writeFile(tmp, JSON.stringify([...this.assets.values()]));
    await rename(tmp, this.indexFile);
  }
}

export function publicAsset(a: StoredAsset): AssetInfo {
  const { id, url, kind, mime, width, height, name } = a;
  return { id, url, kind, mime, width, height, ...(name ? { name } : {}) };
}

import { mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { THUMB_PX } from '../../shared/media.ts';
import { videoFrame } from '../agent/media.ts';
import { config } from '../config.ts';

/** Small WebP stand-ins for board media (a frame for videos), made on first request and kept. */
export class ThumbStore {
  readonly dir = join(config.dataDir, 'thumbs');
  private readonly making = new Map<string, Promise<string>>();

  async init() {
    await mkdir(this.dir, { recursive: true });
  }

  /** Path of the thumbnail for an asset file (`file` as in /files/<file>), made if needed. */
  get(file: string, source: string, video: boolean): Promise<string> {
    const out = join(this.dir, `${file}.webp`);
    let job = this.making.get(file);
    if (!job) {
      job = this.make(source, out, video).finally(() => this.making.delete(file));
      this.making.set(file, job);
    }
    return job;
  }

  private async make(source: string, out: string, video: boolean): Promise<string> {
    try {
      await stat(out);
      return out;
    } catch {
      /* not made yet */
    }
    const input = video ? await videoFrame(source, 0.1) : source;
    const tmp = `${out}.${process.pid}.tmp`;
    await sharp(input).rotate().resize(THUMB_PX, THUMB_PX, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toFile(tmp);
    await rename(tmp, out);
    return out;
  }
}

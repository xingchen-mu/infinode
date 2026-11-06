import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { mimeFor, publicAsset } from '../assets/store.ts';
import { t } from '../i18n.ts';
import type { Services } from '../services.ts';

export function registerAssetsRoutes(app: Hono, { assets, thumbs }: Pick<Services, 'assets' | 'thumbs'>) {
  app.get('/api/assets', (c) => c.json(assets.list().map(publicAsset)));

  app.post('/api/assets', async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return c.json({ error: t('缺少文件') }, 400);
    if (file.size > 200 * 1024 * 1024) return c.json({ error: t('文件过大（上限 200MB）') }, 400);
    const width = Number(body.width) || undefined;
    const height = Number(body.height) || undefined;
    const asset = await assets.save(new Uint8Array(await file.arrayBuffer()), {
      filename: file.name,
      mime: file.type || mimeFor(file.name),
      size: width && height ? { width, height } : undefined,
      name: typeof body.name === 'string' ? body.name : file.name,
    });
    return c.json(publicAsset(asset));
  });

  app.post('/api/assets/:id/size', async (c) => {
    const { width, height } = await c.req.json<{ width: number; height: number }>();
    assets.updateSize(c.req.param('id'), width, height);
    return c.json({ ok: true });
  });

  // Small WebP versions for the board (a frame for videos), so a big board does not load every original.
  app.get('/files/thumb/:file', async (c) => {
    const name = c.req.param('file');
    const mime = /^[\w-]+\.\w+$/.test(name) ? mimeFor(name) : undefined;
    if (!mime) return c.notFound();
    const source = `${assets.dir}/${name}`;
    try {
      await stat(source);
      const data = await readFile(await thumbs.get(name, source, mime.startsWith('video/')));
      return c.body(new Uint8Array(data), 200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable' });
    } catch {
      // Missing file, or a video frame without ffmpeg: the page falls back to the original.
      return c.notFound();
    }
  });

  // Asset files, with Range support so videos can seek.
  app.get('/files/:file', async (c) => {
    const name = c.req.param('file');
    if (!/^[\w-]+\.\w+$/.test(name)) return c.notFound();
    const path = `${assets.dir}/${name}`;
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return c.notFound();
    }
    const headers: Record<string, string> = {
      'Content-Type': mimeFor(name) ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Accept-Ranges': 'bytes',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(size - 1, end);
      if (start > end) return c.body(null, 416, { 'Content-Range': `bytes */${size}` });
      const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
      return c.body(stream, 206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) });
    }
    const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
    return c.body(stream, 200, { ...headers, 'Content-Length': String(size) });
  });
}

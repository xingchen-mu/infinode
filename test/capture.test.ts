import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import type { AssetInfo, CanvasItem, Project, Task } from '../shared/types.ts';
import { lastFrame } from '../server/agent/media.ts';
import { canvasTools } from '../server/agent/tools.ts';

const skip = spawnSync('ffmpeg', ['-version']).status === 0 ? false : 'ffmpeg is not installed';
const dir = mkdtempSync(join(tmpdir(), 'infinode-capture-'));

/** One second at 10 fps of ffmpeg's test pattern, whose frames all differ. */
function clip(): string {
  const out = join(dir, 'clip.mp4');
  spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x90:rate=10', '-pix_fmt', 'yuv420p', '-y', out]);
  return out;
}

/** Frame `n` of a video, as raw pixels. */
async function frame(path: string, n: number): Promise<Buffer> {
  const png = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-']).stdout;
  return sharp(png).raw().toBuffer();
}

test('lastFrame gives the very last frame of a video', { skip }, async () => {
  const path = clip();
  const last = await sharp(await lastFrame(path)).raw().toBuffer();
  assert.deepEqual(last, await frame(path, 9));
  assert.notDeepEqual(last, await frame(path, 8));
});

test('capture_frame puts the last frame beside its video, linked to it; with a group it goes into that column', { skip }, async () => {
  const path = clip();
  const media = (id: string, kind: 'image' | 'video'): AssetInfo => ({ id, url: `/files/${id}`, kind, mime: kind === 'video' ? 'video/mp4' : 'image/png', width: 160, height: 90 });
  const video: CanvasItem = { id: 'vid0000001', kind: 'video', x: 0, y: 0, w: 640, h: 360, name: 'S03', createdAt: 1, asset: media('avid', 'video') };
  const key: CanvasItem = { id: 'key0000001', kind: 'image', x: 3000, y: 0, w: 512, h: 288, name: 'S01', group: '关键帧', createdAt: 1, asset: media('akey', 'image') };
  const project: Project = { id: 'board00001', name: 't', items: [video, key], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: 0, updatedAt: 0 };
  const saved: Buffer[] = [];
  const deps = {
    tasks: { list: () => [] as Task[] },
    assets: {
      get: (id: string) => (id === 'avid' ? { ...media(id, 'video'), file: 'clip.mp4', createdAt: 1 } : undefined),
      path: () => path,
      save: async (data: Buffer, opts: { size: { width: number; height: number }; name?: string }) => {
        saved.push(data);
        return { ...media(`shot${saved.length}`, 'image'), ...opts.size, name: opts.name, file: `shot${saved.length}.png`, createdAt: Date.now() };
      },
    },
    projects: {
      get: async () => project,
      patchItems: async (_id: string, patch: { upsert?: CanvasItem[] }) => {
        project.items.push(...(patch.upsert ?? []));
        return project;
      },
    },
    changed: () => {},
  } as unknown as Parameters<typeof canvasTools>[0];
  const capture = canvasTools(deps, {} as Parameters<typeof canvasTools>[1]).find((t) => t.name === 'capture_frame')!;
  const ctx = { projectId: project.id };

  const out = await capture.run({ id: video.id }, ctx);
  const tail = project.items.find((i) => i.id === out.items![0])!;
  assert.deepEqual(await sharp(saved[0]).raw().toBuffer(), await frame(path, 9));
  assert.deepEqual([tail.kind, tail.name, tail.inputs, tail.asset?.width], ['image', 'S03 尾帧', [video.id], 160]);
  assert.ok(tail.x >= video.x + video.w && tail.y === video.y, 'to the right of the video, top-aligned');

  const next = await capture.run({ id: video.id, name: 'S04', group: '关键帧' }, ctx);
  const s04 = project.items.find((i) => i.id === next.items![0])!;
  assert.deepEqual([s04.name, s04.group, s04.x], ['S04', '关键帧', key.x]);
  assert.ok(s04.y > key.y + key.h, 'below the last keyframe in its column');

  const early = await capture.run({ id: video.id, seconds: 0.3 }, ctx);
  assert.equal(project.items.find((i) => i.id === early.items![0])!.name, 'S03 第 0.3 秒');
  assert.deepEqual(await sharp(saved[2]).raw().toBuffer(), await frame(path, 3));

  await assert.rejects(capture.run({ id: key.id }, ctx), /是图片/);
});

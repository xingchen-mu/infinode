import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { CanvasItem, Project, Task, TaskRequest } from '../shared/types.ts';
import { type BatchJob, type CanvasDeps, launchBatch } from '../server/agent/board.ts';
import { GAP, intersects, placeRow, visibleRect } from '../shared/geometry.ts';

const img = (id: string, x: number, y: number, w = 512, h = 288): CanvasItem => ({ id, kind: 'image', x, y, w, h, createdAt: 1, asset: { id: `a-${id}`, url: '', kind: 'image', mime: 'image/png', width: 1376, height: 768 } });

/** Just enough of the server for launchBatch: an in-memory board and a task queue that accepts everything. */
function fakeDeps(items: CanvasItem[]) {
  const project: Project = { id: 'board00001', name: 't', items, viewport: { x: 0, y: 0, zoom: 1 }, createdAt: 0, updatedAt: 0 };
  let n = 0;
  const tasks = Object.assign(new EventEmitter(), {
    list: () => [] as Task[],
    create: async (request: TaskRequest) => {
      const video = request.op === 'video.generate';
      return { id: `task${++n}`.padEnd(8, '0'), request, status: 'queued', progress: 0, results: [], seed: 1, createdAt: 0, expected: { kind: video ? 'video' : 'image', width: 1344, height: 768 } } as Task;
    },
  });
  const deps = {
    tasks,
    projects: {
      get: async () => project,
      patchItems: async (_id: string, patch: { upsert?: CanvasItem[] }) => {
        for (const u of patch.upsert ?? []) project.items.push(u);
        return project;
      },
    },
    capabilities: async () => ({ comfyOnline: true, comfyUrl: '', features: {}, models: {} }),
    changed: () => {},
  } as unknown as CanvasDeps;
  return { deps, project, writer: { track() {} } as never };
}

const request = (prompt: string): TaskRequest => ({ op: 'image.generate', model: 'qwen', prompt, aspect: '16:9', quality: '1k', images: [] });

test('placeRow finds a free spot instead of covering an item', () => {
  const items = [img('a', 0, 0)];
  const [p] = placeRow(items, { x: 0, y: 0 }, [{ w: 512, h: 288 }]);
  assert.equal(intersects({ ...p, w: 512, h: 288 }, items[0], GAP / 2), false);
});

test('a column batch stacks in order beside its first input, without overlaps', async () => {
  const ref = img('ref', 0, 0);
  const { deps, writer, project } = fakeDeps([ref]);
  const jobs: BatchJob[] = ['S01', 'S02', 'S03'].map((name) => ({ request: request(name), inputs: [ref], name }));
  const { items } = await launchBatch(deps, writer, project.id, jobs, { layout: 'column' });
  assert.deepEqual(items.map((i) => i.name), ['S01', 'S02', 'S03']);
  assert.ok(items.every((i) => i.x === items[0].x && i.x > ref.x + ref.w));
  assert.ok(items[1].y > items[0].y + items[0].h && items[2].y > items[1].y + items[1].h);
  assert.deepEqual(items[0].inputs, ['ref']);
});

test('the assistant puts each image type in its own column, and later images of a type go below it', async () => {
  const ref = img('ref', 0, 0);
  const { deps, writer, project } = fakeDeps([ref]);
  const job = (name: string, group?: string): BatchJob => ({ request: request(name), inputs: [ref], name, group });
  const noOverlaps = () => {
    const media = project.items;
    for (const a of media) for (const b of media) if (a !== b) assert.equal(intersects(a, b), false, `${a.name} / ${b.name}`);
  };

  // Mixed in one batch: one column per type, in the order the types first appear, side by side.
  const { items } = await launchBatch(deps, writer, project.id, [job('程诺全身', '全身照'), job('程诺特写', '脸部特写'), job('小雨全身', '全身照'), job('小雨特写', '脸部特写')], { layout: 'groups' });
  const [aFull, aFace, bFull, bFace] = items;
  assert.deepEqual([aFull.group, aFace.group], ['全身照', '脸部特写']);
  assert.equal(bFull.x, aFull.x, 'same column');
  assert.ok(bFull.y > aFull.y + aFull.h, 'below, in order');
  assert.equal(bFace.x, aFace.x);
  assert.ok(aFace.x > aFull.x + aFull.w, 'next column to the right');
  assert.equal(aFace.y, aFull.y, 'columns start level');
  assert.ok(aFull.x > ref.x + ref.w);
  noOverlaps();

  // A later call with a type that is already on the board continues that column.
  const { items: [cFull] } = await launchBatch(deps, writer, project.id, [job('阿杰全身', '全身照')], { layout: 'groups' });
  assert.equal(cFull.x, aFull.x);
  assert.ok(cFull.y > bFull.y + bFull.h);
  // No type given: the results still stack, in a new column.
  const { items: plain } = await launchBatch(deps, writer, project.id, [job('v1'), job('v2')], { layout: 'groups' });
  assert.equal(plain[0].x, plain[1].x);
  assert.ok(plain[1].y > plain[0].y + plain[0].h);
  assert.ok(![aFull.x, aFace.x].includes(plain[0].x));
  noOverlaps();
});

test('videos placed beside their frames keep one row per shot, at the frame height', async () => {
  const frames = [img('f1', 0, 0), img('f2', 0, 320), img('f3', 0, 640)];
  const { deps, writer, project } = fakeDeps([...frames]);
  const jobs: BatchJob[] = frames.map((f) => ({
    request: { op: 'video.generate', model: 'minimax', prompt: f.id, aspect: 'auto', quality: '480p', duration: 5, images: [f.asset!.id] },
    inputs: [f],
    size: { w: Math.round(f.h * (1376 / 768)), h: f.h },
  }));
  const { items } = await launchBatch(deps, writer, project.id, jobs, { layout: 'beside' });
  items.forEach((v, i) => {
    assert.equal(v.y, frames[i].y, 'same row as its frame');
    assert.equal(v.h, frames[i].h);
    assert.ok(v.x > frames[i].x + frames[i].w);
  });
  for (const a of items) for (const b of items) if (a !== b) assert.equal(intersects(a, b), false);
});

test('the visible area follows pan and zoom, with a margin around it', () => {
  // Board point (100, 50) at the top-left corner, zoomed out to half size.
  const v = { x: -50, y: -25, zoom: 0.5 };
  assert.deepEqual(visibleRect(v, 800, 600), { x: 100, y: 50, w: 1600, h: 1200 });
  assert.deepEqual(visibleRect(v, 800, 600, 0.5), { x: -700, y: -550, w: 3200, h: 2400 });
});

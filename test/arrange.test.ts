import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanvasItem, Project, Task } from '../shared/types.ts';
import { arrange, besideOf, clearOf } from '../server/agent/layout.ts';
import { canvasTools } from '../server/agent/tools.ts';

const img = (id: string, x: number, y: number, group?: string): CanvasItem => ({
  id,
  kind: 'image',
  x,
  y,
  w: 512,
  h: 288,
  group,
  createdAt: 1,
  asset: { id: `a-${id}`, url: '', kind: 'image', mime: 'image/png', width: 1376, height: 768 },
});
const note = (id: string, x: number, y: number): CanvasItem => ({ id, kind: 'text', x, y, w: 380, h: 260, text: '剧本', createdAt: 1 });
/** A placeholder whose task is still out (or lost): no result yet. */
const pending = (id: string, x: number, y: number): CanvasItem => ({ id, kind: 'image', x, y, w: 512, h: 288, taskId: 'task0001', createdAt: 1 });

/** An in-memory board behind the canvas tools. */
function board(items: CanvasItem[], host: 'panel' | 'mcp' = 'panel') {
  const project: Project = { id: 'board00001', name: 't', items, viewport: { x: 0, y: 0, zoom: 1 }, createdAt: 0, updatedAt: 0 };
  const deps = {
    tasks: { list: () => [] as Task[] },
    projects: {
      get: async () => project,
      patchItems: async (_id: string, patch: { upsert?: CanvasItem[]; remove?: string[] }) => {
        const drop = new Set(patch.remove ?? []);
        const next = new Map(project.items.filter((i) => !drop.has(i.id)).map((i) => [i.id, i]));
        for (const u of patch.upsert ?? []) next.set(u.id, u);
        project.items = [...next.values()];
        return project;
      },
    },
    changed: () => {},
  } as unknown as Parameters<typeof canvasTools>[0];
  const tools = canvasTools(deps, {} as Parameters<typeof canvasTools>[1], host);
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  const at = (id: string) => {
    const i = project.items.find((it) => it.id === id)!;
    return { x: i.x, y: i.y };
  };
  return { project, tool, at };
}
const ctx = { projectId: 'board00001' };

test('arrange lays boxes out in a row, a column, a grid, or one column per type', () => {
  const boxes = [
    { w: 100, h: 50 },
    { w: 200, h: 80 },
    { w: 100, h: 100 },
  ];
  assert.deepEqual(arrange(boxes, 'row'), { positions: [{ x: 0, y: 0 }, { x: 132, y: 0 }, { x: 364, y: 0 }], w: 464, h: 100 });
  assert.deepEqual(arrange(boxes, 'column'), { positions: [{ x: 0, y: 0 }, { x: 0, y: 82 }, { x: 0, y: 194 }], w: 200, h: 294 });
  // Two columns (about square for three): each column as wide, each row as tall as its largest box.
  const grid = { positions: [{ x: 0, y: 0 }, { x: 132, y: 0 }, { x: 0, y: 112 }], w: 332, h: 212 };
  assert.deepEqual(arrange(boxes, 'grid'), grid);
  assert.deepEqual(arrange(boxes, 'grid', { columns: 2 }), grid);
  assert.deepEqual(arrange(boxes, 'grid', { columns: 1 }).positions, arrange(boxes, 'column').positions);

  const typed = [
    { w: 100, h: 50, group: '角色' },
    { w: 200, h: 80, group: '场景' },
    { w: 100, h: 100, group: '角色' },
    { w: 100, h: 40 },
  ];
  assert.deepEqual(arrange(typed, 'groups', { gap: 10 }).positions, [
    { x: 0, y: 0 },
    { x: 120, y: 0 },
    { x: 0, y: 60 },
    { x: 340, y: 0 },
  ]);
});

test('a block put beside an item steps past whatever is in the way, towards the same side', () => {
  const anchor = { x: 0, y: 0, w: 100, h: 100 };
  const size = { x: 999, y: 999, w: 50, h: 50 };
  assert.deepEqual(besideOf(anchor, size, 'right'), { x: 196, y: 0, w: 50, h: 50 });
  assert.deepEqual(besideOf(anchor, size, 'below'), { x: 0, y: 196, w: 50, h: 50 });
  assert.deepEqual(clearOf([{ x: 200, y: 0, w: 100, h: 100 }], besideOf(anchor, size, 'right'), 'right'), { x: 332, y: 0, w: 50, h: 50 });
  assert.deepEqual(clearOf([{ x: -200, y: 0, w: 100, h: 100 }], besideOf(anchor, size, 'left'), 'left'), { x: -282, y: 0, w: 50, h: 50 });
  assert.deepEqual(clearOf([{ x: 0, y: 400, w: 100, h: 100 }], { x: 0, y: 196, w: 50, h: 50 }, 'above').y, 196, 'nothing in the way: stays');
});

test('move_items puts nodes beside another one, shifts them, and puts them back from the positions it listed', async () => {
  const { tool, at } = board([img('a', 0, 0), img('b', 0, 400), img('c', 600, 0), note('n', 1200, 0)]);
  const move = tool('move_items');

  // Beside c, the note is in the way: the block goes past it, a and b keep their places relative to each other.
  const out = await move.run({ ids: ['a', 'b'], beside: 'c' }, ctx);
  assert.deepEqual([at('a'), at('b')], [{ x: 1612, y: 0 }, { x: 1612, y: 400 }]);
  assert.match(out.text, /原位置.*`a` \(0,0\)，`b` \(0,400\)/);
  assert.deepEqual(out.items, ['a', 'b']);

  await move.run({ ids: ['a'], dx: -100, dy: 20 }, ctx);
  assert.deepEqual(at('a'), { x: 1512, y: 20 });

  await move.run({ positions: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 0, y: 400 }] }, ctx);
  assert.deepEqual([at('a'), at('b')], [{ x: 0, y: 0 }, { x: 0, y: 400 }]);

  await assert.rejects(move.run({ ids: ['a', 'c'], beside: 'c' }, ctx));
  await assert.rejects(move.run({ ids: ['a'] }, ctx));
  await assert.rejects(move.run({ ids: ['nope'], dx: 10 }, ctx), /nope/);
});

test('arrange_items lines nodes up in the order given, and steps right of nodes in the way', async () => {
  const { tool, at } = board([img('s3', 0, 0), img('s1', 700, 50), img('s2', 0, 500)]);
  const arrangeItems = tool('arrange_items');
  const out = await arrangeItems.run({ ids: ['s1', 's2', 's3'], layout: 'row' }, ctx);
  assert.deepEqual([at('s1'), at('s2'), at('s3')], [{ x: 0, y: 0 }, { x: 544, y: 0 }, { x: 1088, y: 0 }]);
  assert.match(out.text, /排成一行.*原位置.*`s1` \(700,50\)/);

  const crowded = board([img('s1', 0, 0), img('s2', 0, 400), { ...note('o', 1000, 100), w: 200, h: 200 }]);
  await crowded.tool('arrange_items').run({ ids: ['s1', 's2'], layout: 'row', gap: 100 }, ctx);
  assert.deepEqual([crowded.at('s1'), crowded.at('s2')], [{ x: 1232, y: 0 }, { x: 1844, y: 0 }]);
});

test('delete_items takes only finished images and videos: through a card in the panel, directly for outside agents', async () => {
  const { project, tool } = board([img('a', 0, 0), note('n', 600, 0), pending('p', 0, 400)]);
  const del = tool('delete_items');
  assert.equal(del.destructive, true);
  const out = await del.run({ ids: ['a', 'n', 'p'] }, ctx);
  assert.equal(project.items.length, 3, 'nothing goes before the user says so');
  assert.deepEqual(out.approval && [out.approval.title, out.approval.frames, out.approval.confirm], ['删除 1 张图', ['a'], '删除']);
  assert.match(out.text, /没删：`n`（文本节点），`p`（还没有结果，用 cancel_items）/);

  const done = await del.approve!(out.approval!.payload, ctx);
  assert.deepEqual(project.items.map((i) => i.id), ['n', 'p']);
  assert.equal(done.summary, '删掉了 1 个');
  await assert.rejects(del.run({ ids: ['n', 'p'] }, ctx), /cancel_items/);

  const outside = board([img('a', 0, 0), img('b', 600, 0)], 'mcp');
  const direct = await outside.tool('delete_items').run({ ids: ['a'] }, ctx);
  assert.equal(direct.approval, undefined);
  assert.deepEqual(outside.project.items.map((i) => i.id), ['b']);
});

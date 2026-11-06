import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanvasItem } from '../shared/types.ts';
import { mergeItems } from '../src/projects/merge.ts';

const item = (id: string, x = 0, extra: Partial<CanvasItem> = {}): CanvasItem => ({ id, kind: 'image', x, y: 0, w: 10, h: 10, createdAt: 1, ...extra });
const base = (...items: CanvasItem[]) => new Map(items.map((i) => [i.id, JSON.stringify(i)]));
const ids = (items: CanvasItem[]) => items.map((i) => `${i.id}@${i.x}`).sort();

test('an edit made here wins over the remote copy; untouched items follow the remote', () => {
  const b = base(item('a'), item('b'));
  const merged = mergeItems(b, [item('a', 5), item('b')], [item('a', 9), item('b', 7)]);
  assert.deepEqual(ids(merged), ['a@5', 'b@7']);
});

test('additions on both sides are kept', () => {
  const merged = mergeItems(base(item('a')), [item('a'), item('mine')], [item('a'), item('theirs')]);
  assert.deepEqual(ids(merged), ['a@0', 'mine@0', 'theirs@0']);
});

test('a deletion elsewhere removes untouched items but not ones changed here', () => {
  const b = base(item('a'), item('b'));
  const merged = mergeItems(b, [item('a'), item('b', 3)], []);
  assert.deepEqual(ids(merged), ['b@3']);
});

test('a deletion here sticks unless the item changed elsewhere (the edit wins)', () => {
  const b = base(item('a'), item('b'));
  const merged = mergeItems(b, [], [item('a'), item('b', 4)]);
  assert.deepEqual(ids(merged), ['b@4']);
});

test('an agent filling in a placeholder reaches a page that did not touch it', () => {
  const placeholder = item('p', 0, { taskId: 't1' });
  const done = item('p', 0, { asset: { id: 'x', url: '/files/x.png', kind: 'image', mime: 'image/png', width: 1, height: 1 } });
  const merged = mergeItems(base(placeholder), [placeholder], [done]);
  assert.equal(merged[0].asset?.id, 'x');
});

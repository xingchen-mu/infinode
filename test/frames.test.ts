import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redoneVersion } from '../shared/frames.ts';
import type { CanvasItem } from '../shared/types.ts';

const image = (id: string, createdAt: number, extra: Partial<CanvasItem> = {}): CanvasItem => ({ id, kind: 'image', x: 0, y: 0, w: 1, h: 1, createdAt, name: 'S04', group: '关键帧', ...extra });

test('a keyframe redone after the card is found by name and group; older or unfinished ones are not', () => {
  const frame = image('a', 10);
  const ready = (i: CanvasItem) => i.id !== 'pending';
  const items = [frame, image('before', 15), image('other-shot', 30, { name: 'S05' }), image('other-group', 30, { group: '场景' }), image('pending', 40), image('b', 25), image('c', 35)];
  assert.equal(redoneVersion(items, frame, 20, ready)?.id, 'c', 'the newest ready redo made after the card');
  assert.equal(redoneVersion(items, frame, 50, ready), undefined, 'nothing redone since a later card');
  assert.equal(redoneVersion([...items], { ...frame, name: undefined }, 0, ready), undefined, 'an unnamed frame has no versions');
});

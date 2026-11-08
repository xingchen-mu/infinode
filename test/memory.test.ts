import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), 'infinode-memory-test-'));
const { MemoryStore, memoryBlock } = await import('../server/agent/memory.ts');
const { memoryUpdates } = await import('../server/agent/runtime.ts');

const store = () => new MemoryStore(mkdtempSync(join(tmpdir(), 'infinode-memory-')));
const board = 'board00001';

test('the assistant adds, updates and deletes memory, without saying the same thing twice', async () => {
  const m = store();
  const first = await m.apply(board, [
    { action: 'add', scope: 'board', type: 'setting', text: '主角叫林晚，22 岁，短发' },
    { action: 'add', scope: 'user', type: 'preference', text: '默认 16:9，不要字幕' },
    { action: 'add', scope: 'board', type: 'setting', text: '主角叫林晚，22岁，短发。' },
  ]);
  assert.equal(first.done.length, 2, 'the third says what the first does');
  const saved = await m.read('board', board);
  assert.equal(saved.entries.length, 1);
  const id = saved.entries[0].id;
  assert.equal(saved.entries[0].by, 'assistant');

  await m.apply(board, [{ action: 'update', scope: 'board', id, text: '主角叫林晚，22 岁，长发', why: '用户改了设定' }]);
  assert.deepEqual(
    (await m.read('board', board)).entries.map((e) => [e.text, e.why]),
    [['主角叫林晚，22 岁，长发', '用户改了设定']],
  );
  const gone = await m.apply(board, [{ action: 'delete', scope: 'board', id }, { action: 'delete', scope: 'board', id: 'nope' }]);
  assert.equal(gone.done.length, 1);
  assert.match(gone.refused[0], /没有 nope/);
  assert.equal((await m.read('user', 'another0001')).entries.length, 1, 'user memory is the same on every board');
});

test('memory refuses what is too long or overflows its scope, and stays out of a scope switched off', async () => {
  const m = store();
  const long = await m.apply(board, [{ action: 'add', scope: 'board', text: '长'.repeat(301) }]);
  assert.match(long.refused[0], /太长了/);
  const many = Array.from({ length: 8 }, (_, i) => ({ action: 'add' as const, scope: 'user' as const, text: `${i} ${'偏'.repeat(140)}` }));
  const full = await m.apply(board, many);
  assert.equal(full.done.length, 7);
  assert.match(full.refused[0], /满了/);

  await m.replace('board', board, { auto: false, entries: [] });
  const off = await m.apply(board, [{ action: 'add', scope: 'board', text: '画风用水彩' }]);
  assert.match(off.refused[0], /关掉了自动记忆/);
  assert.equal((await m.read('board', board)).entries.length, 0);
});

test('the user edits memory in the page: new entries get ids, edited ones become the user\'s, and limits hold', async () => {
  const m = store();
  await m.apply(board, [{ action: 'add', scope: 'board', type: 'decision', text: '画风用日系动画' }]);
  const [kept] = (await m.read('board', board)).entries;
  const saved = await m.replace('board', board, {
    auto: true,
    entries: [kept, { id: '', type: 'setting', text: '女主穿灰色卫衣', at: 0, by: 'user' }, { id: '', type: 'setting', text: '  ', at: 0, by: 'user' }],
  });
  assert.equal(saved.entries.length, 2, 'an empty row is dropped');
  assert.deepEqual([saved.entries[0].id, saved.entries[0].by], [kept.id, 'assistant'], 'unchanged keeps its author');
  assert.ok(saved.entries[1].id.startsWith('m') && saved.entries[1].by === 'user');
  await assert.rejects(m.replace('board', board, { auto: true, entries: [{ text: '长'.repeat(301) }] }), /不超过/);
  await assert.rejects(m.replace('board', board, { entries: 'x' }), /格式错误/);
});

test('the model reads memory with ids and types, and is told a scope is switched off', () => {
  const block = memoryBlock(
    { auto: false, entries: [{ id: 'm1', type: 'decision', text: '画风用日系动画', why: '用户否掉了写实', at: 1, by: 'assistant' }] },
    { auto: true, entries: [] },
  );
  assert.match(block, /- \[m1 · 决定\] 画风用日系动画（用户否掉了写实）/);
  assert.match(block, /### 用户偏好.*\n（空）/);
  assert.match(block, /用户关掉了这部分的自动记忆/);
});

test('memory updates after a summary are read when well-formed, and ignored otherwise', () => {
  const ok = memoryUpdates('## 下一步\n- 出视频\n<memory_updates>\n[{"action":"add","scope":"board","type":"decision","text":"用 480p"},{"action":"jump","scope":"board"},{"action":"delete","scope":"user","id":"m2"}]\n</memory_updates>');
  assert.deepEqual(ok, [
    { action: 'add', scope: 'board', type: 'decision', text: '用 480p' },
    { action: 'delete', scope: 'user', id: 'm2' },
  ]);
  assert.deepEqual(memoryUpdates('<memory_updates>不是 JSON</memory_updates>'), []);
  assert.deepEqual(memoryUpdates('没有这一段'), []);
});

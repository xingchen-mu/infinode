import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeJson } from '../server/agent/write.ts';

test('writes to one file at the same moment all land, and the file ends with the latest state', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'infinode-write-')), 'conversation.json');
  let state = 0;
  const writes = Array.from({ length: 20 }, () => writeJson(file, () => ({ state })));
  state = 19;
  await Promise.all(writes);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { state: 19 });
});

test('a write that fails does not hold up the ones after it', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'infinode-write-')), 'later');
  const file = join(dir, 'watches.json');
  const failed = writeJson(file, () => [1]);
  await assert.rejects(failed, /ENOENT/);
  mkdirSync(dir);
  await writeJson(file, () => [2]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [2]);
});

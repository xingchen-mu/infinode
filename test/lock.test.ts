// One server per data folder, and a desktop backend that stops with its app.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DataDirInUse, lockDataDir, watchParent } from '../server/lock.ts';

/** The id of a process that has already exited. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;
const folder = () => mkdtempSync(join(tmpdir(), 'infinode-lock-'));

test('a second server on the same data folder is refused while the first runs', () => {
  const dir = folder();
  // The test runner's parent stands in for another live server.
  writeFileSync(join(dir, 'server.lock'), JSON.stringify({ pid: process.ppid, port: 8787, startedAt: 1 }));
  assert.throws(() => lockDataDir(dir, 8788), (err: Error) => err instanceof DataDirInUse && err.message.includes(String(process.ppid)) && err.message.includes('8787'));
});

test('a lock left by a server that is gone is taken over, and released on exit', () => {
  const dir = folder();
  const file = join(dir, 'server.lock');
  writeFileSync(file, JSON.stringify({ pid: deadPid(), port: 8787, startedAt: 1 }));
  const release = lockDataDir(dir, 9000);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid);
  release();
  assert.equal(existsSync(file), false);
  // A garbled lock counts as left behind too.
  writeFileSync(file, '{"pid":');
  lockDataDir(dir, 9001)();
});

test('a backend notices when the desktop app that started it is gone', async () => {
  const gone = await new Promise<boolean>((resolve) => {
    watchParent(deadPid(), () => resolve(true), 10);
    setTimeout(() => resolve(false), 1000);
  });
  assert.equal(gone, true);
  let called = false;
  const stop = watchParent(process.pid, () => (called = true), 10);
  await new Promise((r) => setTimeout(r, 60));
  stop();
  assert.equal(called, false, 'a live parent is left alone');
});

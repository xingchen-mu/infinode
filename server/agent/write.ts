import { rename, writeFile } from 'node:fs/promises';

const queues = new Map<string, Promise<void>>();

/**
 * Writes JSON through a .tmp file and a rename, one write at a time per file: two at once would share the
 * .tmp file, and the second rename would fail with ENOENT. `data` is read when the write's turn comes, so
 * the last write in line always carries the latest state.
 */
export function writeJson(file: string, data: () => unknown): Promise<void> {
  const write = async () => {
    await writeFile(`${file}.tmp`, JSON.stringify(data()));
    await rename(`${file}.tmp`, file);
  };
  const next = (queues.get(file) ?? Promise.resolve()).then(write);
  const settled = next.catch(() => {});
  queues.set(file, settled);
  void settled.then(() => {
    if (queues.get(file) === settled) queues.delete(file);
  });
  return next;
}

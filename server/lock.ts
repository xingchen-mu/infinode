import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { t } from './i18n.ts';

interface LockInfo {
  pid: number;
  port: number;
  startedAt: number;
}

/** Whether a process with this id is running (EPERM: it is, under another user). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class DataDirInUse extends Error {}

/**
 * Claims the data folder for this server and returns the release function. Two servers on one folder
 * each keep the task and asset indexes in memory and overwrite the other's on save: a backend the desktop
 * app had lost track of did that, and a board's assets vanished from the index. So a second server stops
 * instead. A lock whose process is gone is taken over.
 */
export function lockDataDir(dir: string, port: number): () => void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'server.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, port, startedAt: Date.now() } satisfies LockInfo));
      closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if ((JSON.parse(readFileSync(file, 'utf8')) as LockInfo).pid === process.pid) rmSync(file, { force: true });
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let holder: Partial<LockInfo> = {};
      try {
        holder = JSON.parse(readFileSync(file, 'utf8')) as LockInfo;
      } catch {
        /* unreadable: treat as left behind */
      }
      if (holder.pid && holder.pid !== process.pid && alive(holder.pid)) {
        throw new DataDirInUse(
          t('数据文件夹 {dir} 已经有一个 Infinode 服务在用（进程 {pid}，端口 {port}）。两个服务同时用一个文件夹会互相覆盖数据，先关掉那个再启动。', {
            dir,
            pid: holder.pid,
            port: holder.port ?? '?',
          }),
        );
      }
      rmSync(file, { force: true });
    }
  }
  throw new Error(`could not lock ${file}`);
}

/**
 * Calls `gone` once the process `pid` has exited. The desktop app passes its own pid, so a backend it can
 * no longer stop (the app crashed or was force quit) does not keep running on its own.
 */
export function watchParent(pid: number, gone: () => void, everyMs = 2000): () => void {
  const timer = setInterval(() => {
    if (alive(pid)) return;
    clearInterval(timer);
    gone();
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

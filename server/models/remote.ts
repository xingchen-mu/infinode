import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DownloadError, type DownloadResult, type DownloadSpec, type FailCode, type OnProgress, type ProbeItem, type ProbeResult } from './transfer.ts';

// Runs server/models/remote-download.py on the ComfyUI machine: `ssh <host> python3 -` with the script and
// its job on stdin. Tests run the same script with a local python instead of ssh.

export interface Runner {
  cmd: string;
  args: string[];
}

let script: string | undefined;
const remoteScript = () => (script ??= readFileSync(new URL('./remote-download.py', import.meta.url), 'utf8'));

/** An ssh_config alias or user@host; nothing ssh could read as an option. */
export const validSshHost = (host: string) => /^[\w.@%:+[\]-]+$/.test(host) && !host.startsWith('-');

export function sshRunner(host: string): Runner {
  return {
    cmd: 'ssh',
    args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3', host, 'python3 -'],
  };
}

type Line =
  | { event: 'progress'; received: number; total?: number | null }
  | ({ event: 'done' } & DownloadResult)
  | ({ event: 'probe' } & ProbeResult)
  | { event: 'error'; code: FailCode; detail?: string; status?: number; partial?: boolean; need?: number; free?: number };

function run(runner: Runner, job: unknown, signal: AbortSignal, onLine: (line: Line) => void): Promise<Line> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const child = spawn(runner.cmd, runner.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    let result: Line | undefined;
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    createInterface({ input: child.stdout }).on('line', (text) => {
      let line: Line;
      try {
        line = JSON.parse(text) as Line;
      } catch {
        return;
      }
      if (line.event === 'progress') onLine(line);
      else result = line;
    });
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(new DownloadError('runner', `${runner.cmd}: ${err.message}`));
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) return reject(signal.reason);
      if (result?.event === 'error') {
        const { code: failCode, detail, ...extra } = result;
        return reject(new DownloadError(failCode, detail ?? '', extra));
      }
      if (result) return resolve(result);
      // No answer from the script: ssh or python failed before it ran.
      const reason = stderr.trim().split('\n').filter(Boolean).at(-1) ?? '';
      reject(new DownloadError('runner', code === 127 || /python3?: (command )?not found|No such file/i.test(reason) ? 'python3 not found' : reason || `exit ${code}`));
    });
    child.stdin.on('error', () => {
      /* reported through close */
    });
    const args = Buffer.from(JSON.stringify(job)).toString('base64');
    child.stdin.end(`ARGS = '${args}'\n${remoteScript()}`);
  });
}

export async function downloadRemote(runner: Runner, spec: DownloadSpec, signal: AbortSignal, onProgress: OnProgress): Promise<DownloadResult> {
  const line = await run(runner, { op: 'download', ...spec }, signal, (l) => {
    if (l.event === 'progress') onProgress({ received: l.received, total: l.total ?? undefined });
  });
  if (line.event !== 'done') throw new DownloadError('runner', 'unexpected reply');
  return { size: line.size, url: line.url, existed: line.existed };
}

export async function probeRemote(runner: Runner, items: ProbeItem[], token: string | undefined, signal: AbortSignal): Promise<ProbeResult> {
  const line = await run(runner, { op: 'probe', files: items, token }, signal, () => {});
  if (line.event !== 'probe') throw new DownloadError('runner', 'unexpected reply');
  return { files: line.files, free: line.free, folderOk: line.folderOk };
}

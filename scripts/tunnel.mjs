// Keeps an SSH tunnel to the ComfyUI server open (reconnecting when it drops).
// Skips (and just idles) when the local port is already served, e.g. by another tunnel.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';

if (existsSync('.env')) process.loadEnvFile('.env');

const host = process.env.SSH_HOST ?? '';
const local = new URL(process.env.COMFY_URL ?? 'http://127.0.0.1:8188');
const localPort = Number(local.port || 8188);
const remotePort = Number(process.env.REMOTE_COMFY_PORT ?? 8188);
const log = (msg) => console.log(`[tunnel] ${msg}`);

const portOpen = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => (s.destroy(), resolve(true)));
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => (s.destroy(), resolve(false)));
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!host || !['127.0.0.1', 'localhost'].includes(local.hostname)) {
  log(`no tunnel needed (COMFY_URL=${local.href})`);
  setInterval(() => {}, 1 << 30);
} else {
  let announced = false;
  for (;;) {
    if (await portOpen(localPort)) {
      if (!announced) log(`port ${localPort} is already open, using it`);
      announced = true;
      await sleep(15000);
      continue;
    }
    announced = false;
    log(`ssh ${host}: localhost:${localPort} -> server:${remotePort}`);
    const ssh = spawn(
      'ssh',
      ['-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3',
        '-L', `${localPort}:127.0.0.1:${remotePort}`, host],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    const code = await new Promise((r) => ssh.on('exit', r));
    log(`ssh exited (${code}), reconnecting in 3s`);
    await sleep(3000);
  }
}

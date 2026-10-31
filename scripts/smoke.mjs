// Starts the production server with no ComfyUI behind it and checks that it answers.
// Run after `npm run build`:  npm run smoke
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = process.env.SMOKE_PORT ?? '8797';
const base = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), 'comfy-canva-smoke-'));

let output = '';
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  // Port 9 has nothing listening, so ComfyUI is always offline here.
  env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: port, DATA_DIR: dataDir, COMFY_URL: 'http://127.0.0.1:9' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => (output += d));
server.stderr.on('data', (d) => (output += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const res = await fetch(base + path);
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res;
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(`server exited with code ${server.exitCode}`);
    try {
      return await get('/api/capabilities');
    } catch {
      await sleep(500);
    }
  }
  throw new Error('server did not answer within 30 s');
}

function check(ok, what, hint) {
  if (!ok) throw new Error(hint ? `${what} (${hint})` : what);
  console.log(`ok - ${what}`);
}

try {
  const caps = await (await waitForServer()).json();
  check(caps.comfyOnline === false, 'capabilities report ComfyUI as offline');
  const presets = await (await get('/api/presets')).json();
  check(Array.isArray(presets) && presets.length > 0, `presets load (${presets.length})`);
  const page = await fetch(base + '/');
  check(page.ok && (await page.text()).includes('<div id="root">'), 'serves the built page', 'run `npm run build` first');
  console.log('smoke test passed');
} catch (err) {
  console.error(`smoke test failed: ${err.message}\n--- server output ---\n${output}`);
  process.exitCode = 1;
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    server.kill();
    await new Promise((r) => server.once('exit', r));
  }
  rmSync(dataDir, { recursive: true, force: true });
}

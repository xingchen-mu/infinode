// Model downloads: picking sources and folders, and both downloaders (this process, and the Python script that
// runs on the ComfyUI machine over SSH) against a local server that redirects like Hugging Face and drops connections.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ModelDownloadJob } from '../shared/types.ts';
import { ComfyError, type ComfyClient } from '../server/comfy/client.ts';
import { buildCatalog, safeModelPath, slotDownload } from '../server/models/catalog.ts';
import { joinPath, pickFolder } from '../server/models/folders.ts';
import { ModelInstaller } from '../server/models/installer.ts';
import { downloadRemote, probeRemote, validSshHost } from '../server/models/remote.ts';
import { MIRROR, OFFICIAL, candidates, normalizeEndpoint } from '../server/models/sources.ts';
import { DownloadError, downloadLocal, probeLocal } from '../server/models/transfer.ts';
import { PresetStore } from '../server/workflows/presets.ts';
import { SLOTS } from '../server/workflows/models.ts';
import { SettingsStore } from '../server/settings.ts';

const FILE = 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors';

test('Hugging Face links move to the chosen endpoint; the token only goes where the user sent it', () => {
  assert.deepEqual(candidates(FILE, { source: 'hf-mirror' }, 'en'), [{ url: `${MIRROR}/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors`, auth: true }]);
  assert.deepEqual(candidates(FILE, { source: 'huggingface' }, 'zh'), [{ url: FILE, auth: true }]);
  assert.equal(candidates(FILE, { source: 'custom', endpoint: 'https://hf.example.cn/proxy' }, 'zh')[0].url, 'https://hf.example.cn/proxy/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors');
  // Auto: the mirror first for Chinese users, without the token; the endpoint that worked last goes first.
  assert.deepEqual(candidates(FILE, { source: 'auto' }, 'zh').map((c) => [new URL(c.url).origin, c.auth]), [[MIRROR, false], [OFFICIAL, true]]);
  assert.deepEqual(candidates(FILE, { source: 'auto' }, 'en').map((c) => new URL(c.url).origin), [OFFICIAL, MIRROR]);
  assert.deepEqual(candidates(FILE, { source: 'auto' }, 'zh', OFFICIAL).map((c) => new URL(c.url).origin), [OFFICIAL, MIRROR]);
  // Other hosts are left alone.
  assert.deepEqual(candidates('https://github.com/x/y/releases/download/v1/m.safetensors', { source: 'hf-mirror' }, 'zh'), [{ url: 'https://github.com/x/y/releases/download/v1/m.safetensors', auth: false }]);
  assert.equal(normalizeEndpoint('hf-mirror.com/'), 'https://hf-mirror.com');
  assert.throws(() => normalizeEndpoint('ftp://x'));
});

test('the models folder is the first one named after the type, as ComfyUI with extra_model_paths reports them', () => {
  const paths = {
    checkpoints: ['/data/models/checkpoints', '/home/u/ComfyUI/models/checkpoints', '/home/u/ComfyUI/output/checkpoints'],
    vae: ['/data/models/SEEDVR2', '/data/models/vae', '/home/u/ComfyUI/models/vae'],
    diffusion_models: ['/data/models/SEEDVR2', '/data/models/unet', '/data/models/diffusion_models'],
    text_encoders: ['/data/models/clip', '/home/u/ComfyUI/models/text_encoders'],
    loras: ['/home/u/ComfyUI/output/loras', '/home/u/ComfyUI/models/loras'],
  };
  assert.equal(pickFolder(paths, 'vae'), '/data/models/vae');
  assert.equal(pickFolder(paths, 'diffusion_models'), '/data/models/diffusion_models');
  assert.equal(pickFolder(paths, 'unet'), '/data/models/unet');
  assert.equal(pickFolder(paths, 'text_encoders'), '/home/u/ComfyUI/models/text_encoders');
  assert.equal(pickFolder({ text_encoders: ['/data/models/clip'] }, 'text_encoders'), '/data/models/clip');
  assert.equal(pickFolder(paths, 'loras'), '/home/u/ComfyUI/models/loras');
  assert.equal(pickFolder(paths, 'latent_upscale_models'), '/data/models/latent_upscale_models');
  assert.equal(pickFolder(null, 'vae'), undefined);
  assert.equal(joinPath('C:\\ComfyUI\\models\\vae', 'sub/a.safetensors'), 'C:\\ComfyUI\\models\\vae\\sub\\a.safetensors');
});

test('only safe model files from the templates can be downloaded, and the built-in tools find theirs', async () => {
  assert.ok(safeModelPath('vae', 'ae.safetensors'));
  assert.ok(safeModelPath('loras', 'wan/high_noise.safetensors'));
  for (const [dir, name] of [['vae', '../ae.safetensors'], ['../vae', 'ae.safetensors'], ['vae', 'model.ckpt'], ['vae', 'a/../../b.safetensors'], ['vae', '-rf.safetensors']]) {
    assert.equal(safeModelPath(dir, name), false, `${dir}/${name}`);
  }
  const presets = new PresetStore();
  await presets.init();
  const catalog = buildCatalog(presets.list().map((p) => p.models));
  assert.ok(catalog.size > 20);
  for (const [key, slot] of Object.entries(SLOTS)) {
    // SeedVR2's node downloads its own models.
    if (key.startsWith('seedvr2.')) continue;
    assert.ok(slotDownload(slot, catalog), `no download for ${key}`);
  }
});

test('SSH hosts that ssh could read as options are refused', () => {
  assert.ok(validSshHost('gpu-server'));
  assert.ok(validSshHost('me@10.0.0.2'));
  assert.equal(validSshHost('-oProxyCommand=x'), false);
  assert.equal(validSshHost('a b'), false);
});

// ---------------------------------------------------------------- a local stand-in for Hugging Face and its CDN

const BODY = randomBytes(1_500_000);
let server: Server;
let base = '';
let cdn = '';
/** Requests that reached the CDN: whether they carried the token, and their Range. */
const seen: { auth: boolean; range?: string }[] = [];
/** The next CDN response stops after this many bytes. */
let dropAfter: number | undefined;
let work = '';

function serveFile(req: IncomingMessage, res: ServerResponse) {
  seen.push({ auth: Boolean(req.headers.authorization), range: req.headers.range });
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Number(m[2]) : BODY.length - 1;
  if (start >= BODY.length) {
    res.writeHead(416, { 'Content-Range': `bytes */${BODY.length}` }).end();
    return;
  }
  const chunk = BODY.subarray(start, end + 1);
  res.writeHead(m ? 206 : 200, { 'Content-Length': chunk.length, 'Accept-Ranges': 'bytes', ...(m ? { 'Content-Range': `bytes ${start}-${end}/${BODY.length}` } : {}) });
  if (dropAfter !== undefined) {
    const cut = dropAfter;
    dropAfter = undefined;
    res.write(chunk.subarray(0, cut), () => setTimeout(() => res.destroy(), 50));
    return;
  }
  res.end(chunk);
}

before(async () => {
  work = await mkdtemp(join(tmpdir(), 'infinode-models-'));
  server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/cdn/')) return serveFile(req, res);
    if (url.startsWith('/private/')) {
      if (req.headers.authorization !== 'Bearer secret') return void res.writeHead(401).end();
      return void res.writeHead(302, { Location: `${cdn}/cdn/file` }).end();
    }
    // Like hf-mirror: a relative redirect on the same host, then on to the CDN on another host.
    if (url.startsWith('/resolve/')) return void res.writeHead(307, { Location: '/moved/file' }).end();
    if (url.startsWith('/moved/')) return void res.writeHead(308, { Location: `${cdn}/cdn/file` }).end();
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  // Another host name for the same server, so the redirect counts as leaving the host.
  cdn = `http://localhost:${port}`;
  // A proxy set for the shell must not catch requests to this server (Python honours *_proxy).
  process.env.no_proxy = process.env.NO_PROXY = '127.0.0.1,localhost';
});

after(async () => {
  server.close();
  await rm(work, { recursive: true, force: true });
});

const closedPort = 'http://127.0.0.1:9/resolve/file';
const never = new AbortController().signal;

const python = spawnSync('python3', ['--version']).status === 0;
const runners = [
  { name: 'this process', download: downloadLocal, probe: (items: Parameters<typeof probeLocal>[0], token?: string) => probeLocal(items, token, never) },
  ...(python
    ? [{
        name: 'the remote script',
        download: (spec: Parameters<typeof downloadLocal>[0], signal: AbortSignal, onProgress: Parameters<typeof downloadLocal>[2]) => downloadRemote({ cmd: 'python3', args: ['-'] }, spec, signal, onProgress),
        probe: (items: Parameters<typeof probeLocal>[0], token?: string) => probeRemote({ cmd: 'python3', args: ['-'] }, items, token, never),
      }]
    : []),
];

for (const r of runners) {
  test(`${r.name}: follows redirects, drops the token off-host, falls back to the next source and resumes`, async () => {
    const folder = join(work, r.name.replace(/\W/g, '-'), 'vae');
    await mkdir(join(folder, '..'), { recursive: true });
    const dest = join(folder, 'ae.safetensors');

    seen.length = 0;
    const probe = await r.probe([{ candidates: [{ url: closedPort, auth: false }, { url: `${base}/resolve/file`, auth: true }], folder, dest }], 'secret');
    assert.equal(probe.files[0].size, BODY.length);
    assert.equal(probe.folderOk, true);
    assert.ok((probe.free ?? 0) > 0);

    // The connection drops partway: the error says so and the .part file keeps what arrived.
    dropAfter = 400_000;
    seen.length = 0;
    const progress: number[] = [];
    await assert.rejects(
      r.download({ candidates: [{ url: closedPort, auth: false }, { url: `${base}/resolve/file`, auth: true }], token: 'secret', folder, dest }, never, (p) => progress.push(p.received)),
      (err: unknown) => err instanceof DownloadError && err.code === 'network' && err.extra.partial === true,
    );
    const partial = (await stat(`${dest}.part`)).size;
    assert.ok(partial > 0 && partial < BODY.length, `partial ${partial}`);
    assert.deepEqual(seen.map((s) => s.auth), [false]);

    // The retry asks for the rest only.
    seen.length = 0;
    const result = await r.download({ candidates: [{ url: `${base}/resolve/file`, auth: true }], token: 'secret', folder, dest }, never, () => {});
    assert.equal(result.size, BODY.length);
    assert.equal(seen[0].range, `bytes=${partial}-`);
    assert.ok((await readFile(dest)).equals(BODY));
    await assert.rejects(stat(`${dest}.part`));

    // Already there: nothing is fetched.
    seen.length = 0;
    const again = await r.download({ candidates: [{ url: `${base}/resolve/file`, auth: false }], folder, dest }, never, () => {});
    assert.deepEqual([again.size, again.existed], [BODY.length, true]);
    assert.equal(seen.length, 0);
  });

  test(`${r.name}: a model behind a login reports the HTTP status, and works with the token`, async () => {
    const folder = join(work, `${r.name.replace(/\W/g, '-')}-auth`, 'loras');
    await mkdir(join(folder, '..'), { recursive: true });
    const dest = join(folder, 'gated.safetensors');
    await assert.rejects(
      r.download({ candidates: [{ url: `${base}/private/file`, auth: true }], folder, dest }, never, () => {}),
      (err: unknown) => err instanceof DownloadError && err.code === 'http' && err.extra.status === 401,
    );
    const ok = await r.download({ candidates: [{ url: `${base}/private/file`, auth: true }], token: 'secret', folder, dest }, never, () => {});
    assert.equal(ok.size, BODY.length);
  });

  test(`${r.name}: refuses to create folders where ComfyUI's models folder does not exist`, async () => {
    const folder = join(work, 'no-such-root', 'vae');
    await assert.rejects(
      r.download({ candidates: [{ url: `${base}/resolve/file`, auth: false }], folder, dest: join(folder, 'x.safetensors') }, never, () => {}),
      (err: unknown) => err instanceof DownloadError && err.code === 'folder',
    );
  });
}

test('the installer downloads into the folder ComfyUI reports, and says what to do when it cannot', async () => {
  const root = join(work, 'comfy', 'models');
  await mkdir(join(root, 'checkpoints'), { recursive: true });
  const comfy = {
    baseUrl: 'http://comfy.test',
    async json(path: string) {
      if (path === '/internal/folder_paths') return { checkpoints: [join(root, 'checkpoints')], vae: [join(root, 'vae')] };
      throw new ComfyError('not found', 404);
    },
  } as unknown as ComfyClient;
  const settings = new SettingsStore();
  settings.value.modelSource = 'custom';
  settings.value.modelEndpoint = base;
  const catalog = new Map([['ae.safetensors', { name: 'ae.safetensors', directory: 'vae', url: 'https://huggingface.co/resolve/file' }]]);
  const events: ModelDownloadJob[] = [];
  let installed = 0;
  const installer = new ModelInstaller({ comfy, settings, catalog: () => catalog, installed: () => installed++, emit: (j) => events.push(j) });

  assert.equal((await installer.info()).mode, 'local');
  const plan = await installer.plan(['ae.safetensors']);
  assert.equal(plan.mode, 'local');
  assert.equal(plan.files[0].path, join(root, 'vae', 'ae.safetensors'));
  assert.equal(plan.files[0].size, BODY.length);
  assert.match(plan.commands, /curl -L --fail -C - -o '.*ae\.safetensors' 'http:\/\/127\.0\.0\.1:\d+\/resolve\/file'/);
  assert.throws(() => installer.start(['unknown.safetensors']), /unknown\.safetensors/);

  const [job] = installer.start(['ae.safetensors']);
  // Asking again while it runs gives the same download.
  assert.equal(installer.start(['ae.safetensors'])[0].id, job.id);
  for (let i = 0; i < 100 && events.at(-1)?.status !== 'done'; i++) await new Promise((r) => setTimeout(r, 50));
  const done = events.at(-1)!;
  assert.equal(done.status, 'done', done.error ?? '');
  assert.equal(done.received, BODY.length);
  assert.equal(installed, 1);
  assert.ok((await readFile(join(root, 'vae', 'ae.safetensors'))).equals(BODY));

  // ComfyUI on another machine and no SSH_HOST: manual, with the commands.
  const remote = { ...comfy, baseUrl: 'http://other.test', json: async () => ({ vae: ['/srv/elsewhere/models/vae'] }) } as unknown as ComfyClient;
  const manual = new ModelInstaller({ comfy: remote, settings, catalog: () => catalog, installed: () => {}, emit: () => {} });
  const info = await manual.info();
  assert.equal(info.mode, 'manual');
  assert.match(info.reason ?? '', /SSH_HOST/);
  assert.match((await manual.plan(['ae.safetensors'])).commands, /mkdir -p '\/srv\/elsewhere\/models\/vae'/);
  // With SSH_HOST the server fetches the files itself.
  const ssh = new ModelInstaller({ comfy: remote, settings, catalog: () => catalog, installed: () => {}, emit: () => {}, sshHost: 'gpu-box' });
  assert.deepEqual([(await ssh.info()).mode, (await ssh.info()).host], ['ssh', 'gpu-box']);
  // ComfyUI down.
  const down = { baseUrl: 'http://down.test', json: async () => { throw new ComfyError('offline'); } } as unknown as ComfyClient;
  assert.equal((await new ModelInstaller({ comfy: down, settings, catalog: () => catalog, installed: () => {}, emit: () => {} }).info()).mode, 'offline');
});

test('a cancelled download stops and keeps its partial file', async () => {
  const folder = join(work, 'cancel', 'vae');
  await mkdir(folder, { recursive: true });
  const dest = join(folder, 'c.safetensors');
  // A file that never finishes arriving.
  await writeFile(`${dest}.part`, BODY.subarray(0, 1000));
  const slow = createServer((_req, res) => {
    res.writeHead(206, { 'Content-Length': BODY.length - 1000, 'Content-Range': `bytes 1000-${BODY.length - 1}/${BODY.length}` });
    res.write(BODY.subarray(1000, 2000));
  });
  await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
  try {
    const ctl = new AbortController();
    const running = downloadLocal({ candidates: [{ url: `http://127.0.0.1:${(slow.address() as AddressInfo).port}/f`, auth: false }], folder, dest }, ctl.signal, () => {});
    setTimeout(() => ctl.abort(new Error('cancelled')), 200);
    await assert.rejects(running, /cancelled/);
    assert.ok((await stat(`${dest}.part`)).size >= 1000);
  } finally {
    slow.closeAllConnections();
    slow.close();
  }
});

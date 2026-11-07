// Exercise the assembled HTTP app against isolated disk storage, without ComfyUI or model calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { get, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import type { AssetInfo, PresetInfo, Project, WorkflowDraft } from '../shared/types.ts';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('feature routes preserve HTTP behavior and existing data paths', { timeout: 30_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'infinode-routes-'));
  const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0', DATA_DIR: dataDir, COMFY_URL: 'http://127.0.0.1:9', ALLOWED_HOSTS: '', AGENT_MODEL: 'missing/test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  server.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill();
      const timer = setTimeout(() => server.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timer);
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 150 && !output.includes('infinode server on'); attempt++) {
    assert.equal(server.exitCode, null, output);
    await pause(100);
  }
  const base = /infinode server on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
  assert.ok(base, `Server did not start: ${output}`);
  const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  // Use node:http because fetch may replace a custom Host header with the URL's host.
  const statusWithHost = (path: string, host: string) => new Promise<number | undefined>((resolve, reject) => {
    const req = get(base + path, { headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Host check timed out')));
  });
  const postStatusWithHost = (path: string, host: string, body: unknown) => new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(base + path, { method: 'POST', headers: { host, 'content-type': 'application/json' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Host check timed out')));
    req.end(JSON.stringify(body));
  });

  await t.test('offline APIs, host guard and local-only routes remain available', async () => {
    assert.equal((await (await request('/api/capabilities')).json()).comfyOnline, false);
    for (const path of ['/api/tasks', '/api/workflows', '/api/projects']) {
      assert.deepEqual(await (await request(path)).json(), []);
    }
    assert.equal((await request('/api/agent/status')).status, 200);
    assert.equal(await statusWithHost('/api/settings', 'untrusted.example'), 403);
    for (const path of ['/api/agent/status', '/mcp']) {
      assert.equal(await statusWithHost(path, '192.0.2.1'), 403);
    }
    const mcp = await request('/mcp', 'POST', {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'route-test', version: '1' } },
    }, { accept: 'application/json, text/event-stream' });
    assert.equal(mcp.status, 200);
    assert.match(await mcp.text(), /serverInfo/);
    assert.equal((await request('/api/presence', 'PUT', { projectId: 'test-board', selection: [] })).status, 200);
    // Model downloads: status for anyone, starting them only from this machine and only for known files.
    const install = await (await request('/api/models/install')).json();
    assert.deepEqual([install.mode, install.jobs], ['offline', []]);
    assert.equal((await request('/api/models/plan', 'POST', { names: ['nothing.safetensors'] })).status, 400);
    assert.equal((await request('/api/models/downloads', 'POST', { names: ['nothing.safetensors'] })).status, 400);
    for (const path of ['/api/models/plan', '/api/models/downloads']) {
      assert.equal(await postStatusWithHost(path, '192.0.2.1', { names: ['ae.safetensors'] }), 403);
    }
    const saved = await (await request('/api/settings', 'PUT', { modelSource: 'hf-mirror', hfToken: 'hf_secret' })).json();
    assert.deepEqual([saved.settings.modelSource, saved.settings.hfTokenConfigured, JSON.stringify(saved).includes('hf_secret')], ['hf-mirror', true, false]);
    assert.equal((await request('/api/settings', 'PUT', { modelSource: 'custom', modelEndpoint: '' })).status, 400);
  });

  await t.test('project saves, conflicts, events and deletion use the original JSON layout', async () => {
    const project: Project = await (await request('/api/projects', 'POST', { name: 'Route test' })).json();
    const abort = new AbortController();
    const events = await fetch(base + '/api/events', { signal: abort.signal });
    assert.match(events.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = events.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    const untilEvent = async (name: string) => {
      const timer = setTimeout(() => abort.abort(), 5000);
      try {
        while (!buffered.includes(`event: ${name}\n`)) {
          const next = await reader.read();
          assert.equal(next.done, false);
          buffered += decoder.decode(next.value, { stream: true });
        }
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      await untilEvent('hello');
      const patch = await request(`/api/projects/${project.id}/items`, 'PATCH', {
        upsert: [{ id: 'note-test', kind: 'text', x: 10, y: 20, w: 200, h: 100, text: 'Saved note', createdAt: Date.now() }],
      }, { 'x-infinode-client': 'test-client' });
      assert.equal(patch.status, 200);
      await untilEvent('project');
      assert.match(buffered, /test-client/);
      const stale = await request(`/api/projects/${project.id}`, 'PUT', { items: [], baseUpdatedAt: project.updatedAt });
      assert.equal(stale.status, 409);
      assert.equal((await stale.json()).project.items.length, 1);
      assert.equal((await request(`/api/projects/${project.id}`, 'PUT', { name: 'Blind save' })).status, 409);
      const current: Project = await (await request(`/api/projects/${project.id}`)).json();
      assert.equal((await request(`/api/projects/${project.id}`, 'PUT', { name: 'Renamed', baseUpdatedAt: current.updatedAt })).status, 200);
      const saved: Project = JSON.parse(await readFile(join(dataDir, 'projects', `${project.id}.json`), 'utf8'));
      assert.equal(saved.name, 'Renamed');
      assert.equal(saved.items[0].text, 'Saved note');
      const snapshot = await request(`/api/projects/${project.id}/snapshots`, 'POST', { name: 'Before branch' });
      assert.equal(snapshot.status, 200);
      const snapshotInfo = await snapshot.json();
      assert.equal(snapshotInfo.itemCount, 1);
      assert.equal((await (await request(`/api/projects/${project.id}/snapshots`)).json()).length, 1);
      await request(`/api/projects/${project.id}/items`, 'PATCH', { upsert: [{ id: 'second-note', kind: 'text', x: 300, y: 20, w: 200, h: 100, text: 'Later note', createdAt: Date.now() }] });
      const restored = await request(`/api/projects/${project.id}/snapshots/${snapshotInfo.id}/restore`, 'POST');
      assert.equal(restored.status, 200);
      assert.equal((await restored.json()).items.length, 1);
      const branch = await request(`/api/projects/${project.id}/branches`, 'POST', { snapshotId: snapshotInfo.id, name: 'Branch copy' });
      assert.equal(branch.status, 200);
      const branchProject = await branch.json();
      assert.notEqual(branchProject.id, project.id);
      assert.equal(branchProject.name, 'Branch copy');
      assert.equal((await request(`/api/projects/${project.id}`, 'DELETE')).status, 200);
      assert.equal((await request(`/api/projects/${project.id}`)).status, 404);
    } finally {
      abort.abort();
      reader.releaseLock();
    }
  });

  await t.test('uploads, thumbnails and range requests still serve stored media', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ff0000' } }).png().toBuffer();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'test.png');
    const uploaded = await fetch(base + '/api/assets', { method: 'POST', body: form });
    assert.equal(uploaded.status, 200);
    const asset: AssetInfo = await uploaded.json();
    assert.equal(asset.width, 2);
    const listed: AssetInfo[] = await (await request('/api/assets')).json();
    assert.deepEqual(listed.map((a) => a.id), [asset.id]);
    assert.equal(listed[0].usage?.references, 0);
    const usageProject: Project = await (await request('/api/projects', 'POST', { name: 'Asset usage' })).json();
    await request(`/api/projects/${usageProject.id}/items`, 'PATCH', { upsert: [{ id: 'asset-ref', kind: 'image', x: 0, y: 0, w: 100, h: 100, asset, createdAt: Date.now() }] });
    const used = (await (await request('/api/assets')).json())[0] as AssetInfo;
    assert.equal(used.usage?.references, 1);
    assert.equal(used.usage?.projects[0]?.name, 'Asset usage');
    await request(`/api/projects/${usageProject.id}`, 'DELETE');
    assert.deepEqual(Buffer.from(await (await request(asset.url)).arrayBuffer()), png);
    assert.deepEqual(await readFile(join(dataDir, 'assets', asset.url.split('/').pop()!)), png);
    const range = await request(asset.url, 'GET', undefined, { range: 'bytes=0-7' });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), `bytes 0-7/${png.length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), png.subarray(0, 8));
    assert.equal((await request(asset.url, 'GET', undefined, { range: 'bytes=99999-' })).status, 416);
    const thumb = await request(asset.url.replace('/files/', '/files/thumb/'));
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get('content-type'), 'image/webp');
  });

  await t.test('workflow imports and settings retain validation and persistence', async () => {
    const presets: PresetInfo[] = await (await request('/api/presets')).json();
    assert.ok(presets.length > 0);
    const preset = await (await request(`/api/presets/${presets[0].id}`)).json();
    const drafted = await request('/api/workflows/draft', 'POST', { json: preset.graph, name: 'Imported.json' });
    assert.equal(drafted.status, 200);
    const draft: WorkflowDraft = await drafted.json();
    assert.ok(draft.issues.some((issue) => issue.type === 'offline'));
    const created = await request('/api/workflows', 'POST', { workflow: draft.workflow });
    assert.equal(created.status, 200);
    const workflow = await created.json();
    assert.equal(JSON.parse(await readFile(join(dataDir, 'workflows', `${workflow.id}.json`), 'utf8')).name, 'Imported');
    assert.equal((await request(`/api/workflows/${workflow.id}/draft`)).status, 200);
    assert.equal((await request(`/api/workflows/${workflow.id}`, 'PUT', { workflow: { ...draft.workflow, name: 'Updated' } })).status, 200);
    assert.equal((await request(`/api/workflows/${workflow.id}`, 'DELETE')).status, 200);
    assert.equal((await request('/api/workflows/draft', 'POST', { json: { nodes: [], links: [] } })).status, 400);
    const settings = await request('/api/settings', 'PUT', { language: 'en', commercialOnly: true });
    assert.equal(settings.status, 200);
    assert.equal((await settings.json()).capabilities.comfyOnline, false);
    assert.equal(JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8')).commercialOnly, true);
    const customSettings = await request('/api/settings', 'PUT', {
      agentModel: 'local-chat',
      agentBaseUrl: 'http://127.0.0.1:11434/v1/',
      agentApiKey: 'route-test-secret',
      agentVision: true,
      agentThinking: 'medium',
    });
    assert.equal(customSettings.status, 200);
    const publicSettings = await (await request('/api/settings')).json();
    assert.equal(publicSettings.agentModel, 'local-chat');
    assert.equal(publicSettings.agentBaseUrl, 'http://127.0.0.1:11434/v1');
    assert.equal(publicSettings.agentApiKeyConfigured, true);
    assert.equal('agentApiKey' in publicSettings, false);
    const customStatus = await (await request('/api/agent/status')).json();
    assert.equal(customStatus.model, 'custom/local-chat');
    assert.equal(customStatus.vision, true);
    assert.equal(customStatus.ready, true);
    const savedSettings = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8'));
    assert.equal(savedSettings.agentApiKey, 'route-test-secret');
    const cleared = await request('/api/settings', 'PUT', { clearAgentApiKey: true });
    assert.equal(cleared.status, 200);
    assert.equal((await (await request('/api/settings')).json()).agentApiKeyConfigured, false);
    assert.equal('agentApiKey' in JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8')), false);
    const blocked = await request('/api/tasks', 'POST', { request: { op: 'image.generate', model: 'qwen', prompt: 'test' } });
    assert.equal(blocked.status, 400);
    assert.match((await blocked.json()).error, /commercial/i);
  });
});

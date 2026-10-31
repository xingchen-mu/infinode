import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Capabilities, CustomWorkflow, PresetInfo, Task, TaskRequest, WorkflowDraft } from '../shared/types.ts';
import { AssetStore, mimeFor, publicAsset } from './assets.ts';
import { ComfyClient, ComfyError } from './comfy.ts';
import { config } from './config.ts';
import { PresetStore } from './presets.ts';
import { ProjectStore } from './projects.ts';
import { SettingsStore, normalizeComfyUrl } from './settings.ts';
import { TaskManager } from './tasks.ts';
import { WorkflowStore } from './workflowStore.ts';
import type { WorkflowIssue } from '../shared/types.ts';
import {
  WorkflowFormatError,
  checkWorkflow,
  detectWorkflow,
  fixModelPaths,
  graphIssues,
  listFields,
  parseWorkflowJson,
  validateGraph,
} from './workflows/custom.ts';
import { REQUIREMENTS, RequestError } from './workflows/index.ts';
import { missingFor, resolveModels } from './workflows/models.ts';

async function stableClientId() {
  const file = join(config.dataDir, 'comfy-client-id');
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch {
    const id = `infinode-${randomUUID().slice(0, 8)}`;
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(file, id);
    return id;
  }
}

await mkdir(config.dataDir, { recursive: true });
const settings = new SettingsStore();
await settings.init();
const comfy = new ComfyClient(settings.value.comfyUrl, await stableClientId());
const assets = new AssetStore();
const projects = new ProjectStore();
const workflows = new WorkflowStore();
const presets = new PresetStore();
const tasks = new TaskManager(
  comfy,
  assets,
  (id) => workflows.get(id) ?? presets.get(id),
  () => (capsCache?.value.comfyUrl === comfy.baseUrl ? capsCache.info : undefined),
);
await Promise.all([assets.init(), projects.init(), workflows.init(), presets.init(), tasks.init()]);

const comfyStatus = EventTargetLike();
comfy.connect(
  (e) => tasks.onComfyEvent(e),
  (online) => {
    comfyStatus.emit(online);
    if (online) {
      void capabilities(true);
      tasks.onReconnect();
    }
  },
);

// ------------------------------------------------------------------ capabilities

type ObjectInfo = Awaited<ReturnType<ComfyClient['objectInfo']>>;
let capsCache: { at: number; value: Capabilities; info: ObjectInfo } | undefined;

/** What the connected ComfyUI can run; also picks model files for the built-in tools. */
async function capabilities(force = false): Promise<Capabilities> {
  if (!force && capsCache && Date.now() - capsCache.at < 60_000 && capsCache.value.comfyUrl === comfy.baseUrl) return capsCache.value;
  try {
    const [info, stats] = await Promise.all([comfy.objectInfo(), comfy.systemStats()]);
    const models = resolveModels(info);
    const gpu = stats.devices[0]?.name ?? '';
    // ComfyUI's triton backend compiles fp8 kernels that pre-Ada GPUs (RTX 3090, A100…) cannot run.
    const noFp8 =
      Boolean(stats.system.argv?.includes('--enable-triton-backend')) &&
      /cuda/i.test(gpu) &&
      !/RTX\s*(40|50)\d\d|RTX\s*\d000 Ada|RTX PRO|\bL4\b|L40|H100|H200|H20\b|GH200|B200|B100|GB200|Ada/i.test(gpu);
    const fp8Issue = (graph: CustomWorkflow['graph']) => {
      if (!noFp8) return [];
      const fixed = structuredClone(graph);
      fixModelPaths(fixed, info);
      const fp8 = Object.values(fixed).some((n) => Object.values(n.inputs).some((v) => typeof v === 'string' && /fp8/i.test(v) && /\.(safetensors|gguf)$/.test(v)));
      return fp8 ? ['fp8 模型（当前 GPU 在 --enable-triton-backend 下不支持 fp8，去掉该启动参数或换 bf16/int8 模型）'] : [];
    };
    const features: Capabilities['features'] = {};
    for (const key of Object.keys(REQUIREMENTS)) features[key] = missingFor(key, info);
    for (const wf of [...workflows.list(), ...presets.list()]) features[`custom:${wf.id}`] = [...validateGraph(wf.graph, info), ...fp8Issue(wf.graph)];
    const value: Capabilities = {
      comfyOnline: true,
      comfyUrl: comfy.baseUrl,
      comfyVersion: stats.system.comfyui_version,
      gpu: stats.devices[0]?.name?.replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*cudaMallocAsync$/, ''),
      features,
      models: Object.fromEntries(Object.entries(models).filter(([, v]) => v)) as Record<string, string>,
    };
    capsCache = { at: Date.now(), value, info };
    return value;
  } catch {
    return {
      comfyOnline: false,
      comfyUrl: comfy.baseUrl,
      features: capsCache?.value.features ?? {},
      models: capsCache?.value.models ?? {},
    };
  }
}

/** /object_info when ComfyUI is reachable (used to type and check imported workflows). */
async function objectInfo(): Promise<ObjectInfo | undefined> {
  await capabilities();
  return capsCache?.value.comfyUrl === comfy.baseUrl ? capsCache.info : undefined;
}

// ------------------------------------------------------------------ app

const app = new Hono();

app.onError((err, c) => {
  const status = err instanceof RequestError || err instanceof WorkflowFormatError ? 400 : err instanceof ComfyError ? 502 : 500;
  if (status === 500) console.error(err);
  return c.json({ error: err.message }, status);
});

app.get('/api/capabilities', async (c) => c.json(await capabilities(c.req.query('refresh') === '1')));

// ------------------------------------------------------------------ settings

app.get('/api/settings', (c) => c.json(settings.value));

/** Checks an address without saving it. */
app.post('/api/settings/test', async (c) => {
  const { comfyUrl } = await c.req.json<{ comfyUrl: string }>();
  let url: string;
  try {
    url = normalizeComfyUrl(comfyUrl);
  } catch (err) {
    return c.json({ ok: false, error: `地址格式不对：${(err as Error).message}` });
  }
  try {
    const probe = new ComfyClient(url, 'probe');
    const stats = await probe.systemStats();
    return c.json({ ok: true, url, version: stats.system.comfyui_version, gpu: stats.devices[0]?.name });
  } catch (err) {
    return c.json({ ok: false, url, error: (err as Error).message });
  }
});

app.put('/api/settings', async (c) => {
  const body = await c.req.json<{ comfyUrl?: string }>();
  if (body.comfyUrl !== undefined) {
    let url: string;
    try {
      url = normalizeComfyUrl(body.comfyUrl);
    } catch (err) {
      throw new RequestError(`地址格式不对：${(err as Error).message}`);
    }
    if (url !== comfy.baseUrl) {
      await settings.save({ comfyUrl: url });
      assets.forgetComfyNames();
      comfy.setBaseUrl(url);
      capsCache = undefined;
    }
  }
  return c.json({ settings: settings.value, capabilities: await capabilities(true) });
});

// ------------------------------------------------------------------ official template presets

app.get('/api/presets', async (c) => {
  const info = await objectInfo();
  const list: PresetInfo[] = presets.list().map(({ graph, ...p }) => {
    const issues = info ? graphIssues(graph, info) : [];
    const missingFiles = [...new Set(issues.filter((i) => i.type === 'file').map((i) => i.value!))];
    const blocked = capsCache?.value.features[`custom:${p.id}`]?.filter((m) => m.startsWith('fp8')) ?? [];
    return {
      ...p,
      missing: {
        nodes: [...new Set(issues.filter((i) => i.type === 'node').map((i) => i.value!))],
        notes: blocked,
        // With a download link when the template provides one.
        models: missingFiles.map((name) => p.models.find((m) => m.name === name) ?? { name, url: '', directory: '' }),
      },
    };
  });
  return c.json(list);
});

/** Full preset (graph included), e.g. to copy it into "my workflows". */
app.get('/api/presets/:id', (c) => {
  const p = presets.get(c.req.param('id'));
  return p ? c.json(p) : c.json({ error: '模板不存在' }, 404);
});

/** Thumbnail from ComfyUI's bundled template package. */
app.get('/api/presets/:id/thumb', async (c) => {
  const p = presets.get(c.req.param('id'));
  if (!p?.thumb) return c.notFound();
  const base = p.thumb.replace(/\.\w+$/, '');
  for (const name of [p.thumb, `${base}.png`, `${base}.jpg`]) {
    try {
      const res = await fetch(`${comfy.baseUrl}/templates/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) continue;
      return c.body(new Uint8Array(await res.arrayBuffer()), 200, {
        'Content-Type': res.headers.get('content-type') ?? 'image/webp',
        'Cache-Control': 'public, max-age=86400',
      });
    } catch {
      /* try the next name */
    }
  }
  return c.notFound();
});

// ------------------------------------------------------------------ imported workflows

app.get('/api/workflows', (c) => c.json(workflows.list()));

const OFFLINE_ISSUE: WorkflowIssue = { type: 'offline', message: 'ComfyUI 未连接，暂时无法检查节点和模型' };

/** Reads an uploaded JSON and proposes a mapping for the editor (nothing is saved). */
app.post('/api/workflows/draft', async (c) => {
  const body = await c.req.json<{ json: unknown; name?: string }>();
  const { graph, saved } = parseWorkflowJson(body.json);
  const info = await objectInfo();
  const draft = detectWorkflow(graph, info);
  const result: WorkflowDraft = {
    ...draft,
    workflow: saved?.inputs && saved.outputs
      ? { name: saved.name ?? '', description: saved.description, kind: saved.kind === 'video' ? 'video' : 'image', graph, inputs: saved.inputs, outputs: saved.outputs }
      : { ...draft.workflow, name: (body.name ?? '').replace(/\.json$/i, '').trim() },
    issues: info ? graphIssues(graph, info) : [OFFLINE_ISSUE],
  };
  return c.json(result);
});

/** Mapping editor data for a saved workflow. */
app.get('/api/workflows/:id/draft', async (c) => {
  const wf = workflows.get(c.req.param('id'));
  if (!wf) return c.json({ error: '工作流不存在' }, 404);
  const info = await objectInfo();
  const { outputCandidates } = detectWorkflow(wf.graph, info);
  const result: WorkflowDraft = {
    workflow: wf,
    fields: listFields(wf.graph, info),
    outputCandidates,
    issues: info ? graphIssues(wf.graph, info) : [OFFLINE_ISSUE],
  };
  return c.json(result);
});

async function saveWorkflow(data: Omit<CustomWorkflow, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) {
  if (!data || typeof data.graph !== 'object' || !Array.isArray(data.inputs) || !Array.isArray(data.outputs)) {
    throw new RequestError('工作流数据不完整');
  }
  const problem = checkWorkflow(data);
  if (problem) throw new RequestError(problem);
  const wf = await workflows.save(data);
  capsCache = undefined;
  return wf;
}

app.post('/api/workflows', async (c) => {
  const { workflow } = await c.req.json<{ workflow: Omit<CustomWorkflow, 'id' | 'createdAt' | 'updatedAt'> }>();
  return c.json(await saveWorkflow({ ...workflow, id: undefined }));
});

app.put('/api/workflows/:id', async (c) => {
  if (!workflows.get(c.req.param('id'))) return c.json({ error: '工作流不存在' }, 404);
  const { workflow } = await c.req.json<{ workflow: Omit<CustomWorkflow, 'id' | 'createdAt' | 'updatedAt'> }>();
  return c.json(await saveWorkflow({ ...workflow, id: c.req.param('id') }));
});

app.delete('/api/workflows/:id', async (c) => {
  await workflows.remove(c.req.param('id'));
  capsCache = undefined;
  return c.json({ ok: true });
});

app.post('/api/assets', async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ error: '缺少文件' }, 400);
  if (file.size > 200 * 1024 * 1024) return c.json({ error: '文件过大（上限 200MB）' }, 400);
  const width = Number(body.width) || undefined;
  const height = Number(body.height) || undefined;
  const asset = await assets.save(new Uint8Array(await file.arrayBuffer()), {
    filename: file.name,
    mime: file.type || mimeFor(file.name),
    size: width && height ? { width, height } : undefined,
    name: typeof body.name === 'string' ? body.name : file.name,
  });
  return c.json(publicAsset(asset));
});

app.post('/api/assets/:id/size', async (c) => {
  const { width, height } = await c.req.json<{ width: number; height: number }>();
  assets.updateSize(c.req.param('id'), width, height);
  return c.json({ ok: true });
});

// Asset files, with Range support so videos can seek.
app.get('/files/:file', async (c) => {
  const name = c.req.param('file');
  if (!/^[\w-]+\.\w+$/.test(name)) return c.notFound();
  const path = `${assets.dir}/${name}`;
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return c.notFound();
  }
  const headers: Record<string, string> = {
    'Content-Type': mimeFor(name) ?? 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end) return c.body(null, 416, { 'Content-Range': `bytes */${size}` });
    const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
    return c.body(stream, 206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) });
  }
  const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
  return c.body(stream, 200, { ...headers, 'Content-Length': String(size) });
});

app.get('/api/tasks', (c) => {
  const ids = c.req.query('ids');
  return c.json(tasks.list(ids ? ids.split(',').filter(Boolean) : undefined));
});

app.post('/api/tasks', async (c) => {
  const body = await c.req.json<{ request: TaskRequest; id?: string }>();
  const req = body?.request;
  if (!req || typeof req.op !== 'string') throw new RequestError('请求格式错误');
  await capabilities(); // keeps the built-in tools' model picks current
  return c.json(await tasks.create(req, body.id));
});

app.post('/api/tasks/:id/cancel', async (c) => {
  const task = await tasks.cancel(c.req.param('id'));
  return task ? c.json(task) : c.json({ error: '任务不存在' }, 404);
});

app.get('/api/events', (c) =>
  streamSSE(c, async (stream) => {
    const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
    const onTask = (t: Task) => void send('task', t);
    const onComfy = (online: boolean) => void send('comfy', { online });
    tasks.on('task', onTask);
    comfyStatus.on(onComfy);
    stream.onAbort(() => {
      tasks.off('task', onTask);
      comfyStatus.off(onComfy);
    });
    await send('hello', { comfyOnline: comfy.online, active: tasks.active() });
    while (!stream.aborted) {
      await stream.sleep(15_000);
      await stream.writeSSE({ event: 'ping', data: '' }).catch(() => {});
    }
  }),
);

app.get('/api/projects', async (c) => c.json(await projects.list()));
app.post('/api/projects', async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  return c.json(await projects.create(body.name));
});
app.get('/api/projects/:id', async (c) => {
  const p = await projects.get(c.req.param('id'));
  return p ? c.json(p) : c.json({ error: '画布不存在' }, 404);
});
app.put('/api/projects/:id', async (c) => {
  const p = await projects.save(c.req.param('id'), await c.req.json());
  return p ? c.json({ updatedAt: p.updatedAt }) : c.json({ error: '画布不存在' }, 404);
});
app.delete('/api/projects/:id', async (c) => {
  await projects.remove(c.req.param('id'));
  return c.json({ ok: true });
});

if (config.production) {
  app.use('/*', serveStatic({ root: './dist' }));
  app.get('*', serveStatic({ path: './dist/index.html' }));
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`infinode server on http://${config.host}:${info.port}  (ComfyUI: ${comfy.baseUrl})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void Promise.allSettled([tasks.flush(), assets.flush()]).then(() => process.exit(0));
  });
}

/** Tiny listener set for the ComfyUI online flag. */
function EventTargetLike() {
  const fns = new Set<(online: boolean) => void>();
  return {
    on: (fn: (online: boolean) => void) => void fns.add(fn),
    off: (fn: (online: boolean) => void) => void fns.delete(fn),
    emit: (online: boolean) => fns.forEach((fn) => fn(online)),
  };
}

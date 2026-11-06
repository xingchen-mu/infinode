// Runs one workflow against the real ComfyUI server, using the same builders as the app.
//
//   npm run test:wf -- '{"op":"image.generate","model":"zimage","prompt":"a cat","aspect":"1:1","quality":"1k"}'
//   npm run test:wf -- '{"op":"image.removeBg","files":["out/cat.png"]}'
//   npm run test:wf -- mask out/mask.png 1024 1024 300 300 200 160      (white ellipse: cx cy rx ry)
//
// "files" / "maskFile" are local paths that get uploaded; outputs go to $OUT (default ./scratch-out).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { imageSize } from 'image-size';
import { ComfyClient, historyError, historyFiles } from '../server/comfy/client.ts';
import { buildWorkflow } from '../server/workflows/index.ts';
import type { TaskRequest } from '../shared/types.ts';

function grayPng(w: number, h: number, pixel: (x: number, y: number) => number): Buffer {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = pixel(x, y);
  const chunk = (type: string, data: Buffer) => {
    const td = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const args = process.argv.slice(2);
if (args[0] === 'mask') {
  const [, file, w, h, cx, cy, rx, ry] = args;
  const [W, H, CX, CY, RX, RY] = [w, h, cx, cy, rx, ry].map(Number);
  await writeFile(file, grayPng(W, H, (x, y) => (((x - CX) / RX) ** 2 + ((y - CY) / RY) ** 2 <= 1 ? 255 : 0)));
  console.log('wrote', file);
  process.exit(0);
}

const comfy = new ComfyClient(process.env.COMFY_URL ?? 'http://127.0.0.1:8188', `infinode-test-${process.pid}`);
const outDir = process.env.OUT ?? 'scratch-out';
await mkdir(outDir, { recursive: true });

async function uploadLocal(path: string) {
  const data = await readFile(path);
  const dim = imageSize(data);
  const comfyName = await comfy.upload(data, `test_${basename(path)}`);
  return { comfyName, width: dim.width, height: dim.height };
}

const req = JSON.parse(args[0]) as TaskRequest & { files?: string[]; maskFile?: string };
const images = await Promise.all((req.files ?? []).map(uploadLocal));
const mask = req.maskFile ? await uploadLocal(req.maskFile) : undefined;
const wf = buildWorkflow(req, { images, mask }, req.seed ?? 42, () => undefined);
console.log('expected', wf.expected);
if (process.env.DUMP) console.log(JSON.stringify(wf.graph, null, 1));

const stageIds = new Set(wf.stages.map((s) => s.node));
let promptId = '';
let lastNode = '';
let lastPct = -1;
comfy.connect(
  (e) => {
    if (e.data?.prompt_id !== promptId) return;
    if (e.type === 'executing' && e.data.node && e.data.node !== lastNode) {
      lastNode = String(e.data.node);
      const node = wf.graph[lastNode];
      console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s executing #${lastNode} ${node?.class_type ?? ''}`);
      lastPct = -1;
    }
    if (e.type === 'progress' && stageIds.has(String(e.data.node))) {
      const pct = Math.floor((Number(e.data.value) / Number(e.data.max)) * 4) * 25;
      if (pct !== lastPct) console.log(`    progress ${e.data.value}/${e.data.max}`);
      lastPct = pct;
    }
  },
  () => {},
);

const t0 = Date.now();
await new Promise((r) => setTimeout(r, 300)); // let the websocket connect first
try {
  ({ prompt_id: promptId } = await comfy.queuePrompt(wf.graph, crypto.randomUUID()));
} catch (err) {
  console.error('SUBMIT ERROR:', (err as Error).message);
  process.exit(1);
}
console.log('queued', promptId);
for (;;) {
  await new Promise((r) => setTimeout(r, 1500));
  const entry = await comfy.history(promptId);
  if (!entry?.status?.completed && entry?.status?.status_str !== 'error') continue;
  const err = historyError(entry);
  console.log(`status ${entry.status.status_str} in ${((Date.now() - t0) / 1000).toFixed(1)}s${err ? ` — ${err}` : ''}`);
  for (const f of historyFiles(entry, wf.outputNodes)) {
    const data = await comfy.view(f);
    const dst = join(outDir, basename(f.filename));
    await writeFile(dst, data);
    let dims = '';
    try {
      const d = imageSize(data);
      dims = ` ${d.width}x${d.height}`;
    } catch {
      /* video */
    }
    console.log('output', dst, data.length, 'bytes' + dims);
  }
  console.log('raw outputs', JSON.stringify(entry.outputs[wf.outputNodes[0]] ?? {}).slice(0, 400));
  break;
}
comfy.close();

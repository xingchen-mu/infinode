// Maintainer tool: turns ComfyUI's official templates into canvas presets (presets/*.json).
//
//   npm run build:presets                 all sources below
//   npm run build:presets -- z-image-turbo qwen-image-2.1-edit
//
// Needs a running ComfyUI (COMFY_URL) with the workflow templates package, and Google Chrome:
// each template is loaded into ComfyUI's own frontend and exported exactly like "Export (API)".
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import type { ComfyApiGraph, WorkflowInput } from '../shared/types.ts';
import { detectWorkflow, parseWorkflowJson, simplifyGraph } from '../server/workflows/custom.ts';
import { PRESET_SOURCES, type PresetSource } from './preset-sources.ts';

const COMFY = (process.env.COMFY_URL ?? 'http://127.0.0.1:8188').replace(/\/$/, '');
const only = process.argv.slice(2);

interface ModelRef {
  name: string;
  url: string;
  directory: string;
}

type UiNode = { id: number; type: string; title?: string; properties?: { models?: ModelRef[] } };
type UiGraph = { nodes: UiNode[]; definitions?: { subgraphs?: { nodes: UiNode[] }[] } };

function modelsOf(ui: UiGraph): ModelRef[] {
  const seen = new Map<string, ModelRef>();
  const nodes = [...ui.nodes, ...(ui.definitions?.subgraphs ?? []).flatMap((s) => s.nodes)];
  for (const n of nodes) for (const m of n.properties?.models ?? []) if (m?.name && !seen.has(m.name)) seen.set(m.name, m);
  return [...seen.values()];
}

/** "Float (Duration)" → node, by exact title (or "<nodeId>.<field>"). */
function applySet(graph: ComfyApiGraph, set: Record<string, unknown>) {
  for (const [key, value] of Object.entries(set)) {
    const byId = /^([\w:]+)\.(\w+)$/.exec(key);
    if (byId && graph[byId[1]]) {
      graph[byId[1]].inputs[byId[2]] = value;
      continue;
    }
    const hits = Object.values(graph).filter((n) => n._meta?.title === key);
    if (!hits.length) throw new Error(`set: no node titled "${key}"`);
    for (const n of hits) n.inputs.value = value;
  }
}

function curate(inputs: WorkflowInput[], src: PresetSource, graph: ComfyApiGraph): WorkflowInput[] {
  let out = inputs.filter((i) => !src.drop?.includes(i.id));
  out = out.map((i) => ({ ...i, ...(src.inputs?.[i.id] ?? {}) }));
  for (const extra of src.add ?? []) {
    if (!graph[extra.node] || !(extra.field in graph[extra.node].inputs)) throw new Error(`add: no ${extra.node}.${extra.field}`);
    out.push(extra);
  }
  // Parameters not listed in `inputs` are dropped unless keepParams is set: presets stay simple.
  if (!src.keepParams) out = out.filter((i) => !['number', 'text', 'select', 'boolean'].includes(i.type) || src.inputs?.[i.id] || src.add?.includes(i));
  return out;
}

const info = await (await fetch(`${COMFY}/object_info`)).json();
const index = (await (await fetch(`${COMFY}/templates/index.json`)).json()) as { templates: { name: string; usage?: number; size?: number; tags?: string[] }[] }[];
const meta = new Map(index.flatMap((c) => c.templates).map((t) => [t.name, t as typeof t & { mediaSubtype?: string }]));

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
const sources = PRESET_SOURCES.filter((s) => !only.length || only.includes(s.id));
let failed = 0;
for (const src of sources) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    const ui = (await (await fetch(`${COMFY}/templates/${src.template}.json`)).json()) as UiGraph;
    await page.goto(`${COMFY}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.canvas, null, { timeout: 120_000 });
    await page.waitForTimeout(1500);
    const api = await page.evaluate(async (wf) => {
      const app = (window as any).app;
      await app.loadGraphData(wf, true, false);
      return (await app.graphToPrompt()).output;
    }, ui);
    const { graph: raw } = parseWorkflowJson(api);
    if (src.set) applySet(raw, src.set);
    const outputs = detectWorkflow(raw, info).workflow.outputs;
    const graph = simplifyGraph(raw, outputs);
    const detected = detectWorkflow(graph, info);
    const inputs = curate(detected.workflow.inputs, src, graph);
    if (process.env.DEBUG) {
      for (const i of detected.workflow.inputs) {
        const d = typeof i.default === 'string' && i.default.length > 50 ? `${i.default.slice(0, 50)}…` : i.default;
        console.log(`    ${i.type.padEnd(8)} ${i.id.padEnd(22)} #${i.node} ${graph[i.node]?.class_type}.${i.field} | ${i.label} | ${JSON.stringify(d)}`);
      }
    }
    const used = new Set(Object.values(graph).flatMap((n) => Object.values(n.inputs).filter((v) => typeof v === 'string')));
    const t = meta.get(src.template);
    const preset = {
      format: 'infinode/preset',
      version: 1,
      id: src.id,
      template: src.template,
      name: src.name,
      description: src.description,
      category: src.category,
      kind: detected.workflow.kind,
      usage: t?.usage ?? 0,
      tags: t?.tags ?? [],
      thumb: `${src.template}-1.${t?.mediaSubtype ?? 'webp'}`,
      graph,
      inputs,
      outputs: detected.workflow.outputs,
      // Download hints for the models this (simplified) graph still uses.
      models: modelsOf(ui).filter((m) => used.has(m.name) || [...used].some((u) => String(u).endsWith(`/${m.name}`))),
    };
    await writeFile(`presets/${src.id}.json`, JSON.stringify(preset, null, 1) + '\n');
    const summary = inputs.map((i) => `${i.type}${i.type === 'image' || i.type === 'video' ? `(${i.label})` : ''}`).join(' ');
    console.log(`ok  ${src.id.padEnd(26)} ${preset.kind.padEnd(5)} ${Object.keys(graph).length}/${Object.keys(raw).length} nodes  ${summary}`);
  } catch (err) {
    failed++;
    console.log(`ERR ${src.id}: ${(err as Error).message.split('\n')[0]}`);
  } finally {
    await page.close();
  }
}
await browser.close();
process.exit(failed ? 1 : 0);

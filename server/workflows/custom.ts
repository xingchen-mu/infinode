// Workflows users import from their own ComfyUI ("Export (API)" JSON).
//
// Import: work out which node fields take the prompt, images, seed, size… and which nodes save
// the results. Authors can pin roles with node titles: "@prompt", "@negative", "@image",
// "@image:人物", "@video", "@mask", "@seed", "@size", "@output".
// Run: copy the graph, write the canvas inputs into those fields, queue it.

import type {
  ComfyApiGraph,
  ComfyApiNode,
  CustomWorkflow,
  MediaKind,
  TaskRequest,
  WorkflowDraft,
  WorkflowField,
  WorkflowInput,
  WorkflowIssue,
} from '../../shared/types.ts';
import { type BuiltWorkflow, type InputFile, type Stage, parseAspect, sizeForAspect } from './graph.ts';
import { comboOptions } from './models.ts';

export class WorkflowFormatError extends Error {}

type ObjectInfo = Record<
  string,
  { input: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> }; output_node?: boolean; display_name?: string }
>;

const LOADERS: Record<string, { type: 'image' | 'video' | 'mask'; field: string }> = {
  LoadImage: { type: 'image', field: 'image' },
  LoadImageMask: { type: 'mask', field: 'image' },
  LoadVideo: { type: 'video', field: 'file' },
  VHS_LoadVideo: { type: 'video', field: 'video' },
};

const SAVERS = new Set(['SaveImage', 'SaveImageAdvanced', 'SaveVideo', 'VHS_VideoCombine', 'SaveAnimatedWEBP', 'SaveAnimatedPNG', 'SaveWEBM', 'Image Save']);
const PREVIEWS = new Set(['PreviewImage']);
const VIDEO_SAVERS = new Set(['SaveVideo', 'VHS_VideoCombine', 'SaveWEBM']);
const NOT_RESULTS = new Set(['PreviewAny', 'ShowText', 'ShowText|pysssss', 'Note', 'MarkdownNote', 'PreviewAudio', 'SaveAudio', 'MaskPreview']);
const HEAVY = /KSampler|SamplerCustom|Sampler(Advanced)?$|Upscaler|VideoCombine/;
const TEXT_FIELD = /^(text|prompt|positive|text_g|text_l|value|string|positive_prompt|negative|negative_prompt|text_positive|text_negative)$/i;

function isLink(v: unknown): v is [string, number] {
  return Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number') && typeof v[1] === 'number';
}

function byNumericId(a: string, b: string) {
  const na = Number(a.split(':').pop());
  const nb = Number(b.split(':').pop());
  return Number.isFinite(na) && Number.isFinite(nb) && na !== nb ? na - nb : a.localeCompare(b);
}

function tagOf(node: ComfyApiNode): { role: string; label?: string } | null {
  const m = /^@(\w+)(?::\s*(.+))?$/.exec((node._meta?.title ?? '').trim());
  return m ? { role: m[1].toLowerCase(), label: m[2]?.trim() } : null;
}

const DEFAULT_TITLES = /^(load ?image|load ?video|load image \(as mask\)|加载图像|加载图片|加载视频|加载图像（作为遮罩）|加载遮罩|图像加载)$/i;

/** Title the author gave the node, if it is not just the node's (possibly translated) default name. */
function customTitle(node: ComfyApiNode, info?: ObjectInfo): string | undefined {
  const t = node._meta?.title?.trim();
  if (!t || t.startsWith('@')) return undefined;
  const display = info?.[node.class_type]?.display_name;
  if (t === node.class_type || t === display || DEFAULT_TITLES.test(t)) return undefined;
  return t;
}

/** Accepts our share format or a ComfyUI API export; explains how to fix a UI-format file. */
export function parseWorkflowJson(json: unknown): { graph: ComfyApiGraph; saved?: Partial<CustomWorkflow> } {
  if (!json || typeof json !== 'object') throw new WorkflowFormatError('不是有效的 JSON 文件');
  const obj = json as Record<string, unknown>;
  if (obj.format === 'comfy-canva/workflow' && obj.graph && typeof obj.graph === 'object') {
    const { format: _f, version: _v, ...rest } = obj;
    return { graph: obj.graph as ComfyApiGraph, saved: rest as Partial<CustomWorkflow> };
  }
  if (Array.isArray(obj.nodes) && Array.isArray(obj.links)) {
    throw new WorkflowFormatError(
      '这是 ComfyUI 的普通工作流文件。请在 ComfyUI 里打开它，然后用菜单「工作流 → 导出 (API)」(Workflow → Export (API)) 导出，再导入导出的文件。',
    );
  }
  const source = (obj.prompt && typeof obj.prompt === 'object' ? obj.prompt : obj) as Record<string, unknown>;
  const graph: ComfyApiGraph = {};
  // Notes and other frontend-only nodes come out without a class_type; ComfyUI would reject them.
  for (const [id, n] of Object.entries(source)) {
    if (!n || typeof n !== 'object' || typeof (n as ComfyApiNode).class_type !== 'string') continue;
    const node = n as ComfyApiNode;
    graph[id] = { ...node, inputs: node.inputs && typeof node.inputs === 'object' ? node.inputs : {} };
  }
  if (!Object.keys(graph).length) {
    throw new WorkflowFormatError('没有找到 ComfyUI 节点。请导入 ComfyUI「导出 (API)」得到的 JSON 文件。');
  }
  return { graph };
}

/** Every primitive field, typed from /object_info when available. */
export function listFields(graph: ComfyApiGraph, info?: ObjectInfo): WorkflowField[] {
  const fields: WorkflowField[] = [];
  for (const id of Object.keys(graph).sort(byNumericId)) {
    const node = graph[id];
    const def = info?.[node.class_type];
    for (const [field, value] of Object.entries(node.inputs)) {
      if (isLink(value) || value === null || typeof value === 'object') continue;
      const spec = def?.input.required?.[field] ?? def?.input.optional?.[field];
      const opts = comboOptions(spec);
      const type = spec && typeof spec[0] === 'string' ? (spec[0] as string) : undefined;
      const meta = (spec?.[1] ?? {}) as { min?: number; max?: number; step?: number };
      let kind: WorkflowField['kind'];
      if (opts) kind = 'select';
      else if (type === 'BOOLEAN' || typeof value === 'boolean') kind = 'boolean';
      else if (type === 'INT' || type === 'FLOAT' || typeof value === 'number') kind = 'number';
      else kind = 'text';
      fields.push({
        node: id,
        classType: node.class_type,
        title: node._meta?.title,
        field,
        value,
        kind,
        ...(opts ? { options: opts.map(String) } : {}),
        ...(kind === 'number' ? { min: meta.min, max: meta.max, step: meta.step ?? (type === 'INT' ? 1 : undefined) } : {}),
      });
    }
  }
  return fields;
}

/** What the connected server lacks to run this graph (files it can substitute are listed as 'auto'). */
export function graphIssues(source: ComfyApiGraph, info: ObjectInfo): WorkflowIssue[] {
  const graph = structuredClone(source);
  const issues: WorkflowIssue[] = fixModelPaths(graph, info).map((c) => ({
    type: 'auto',
    node: c.node,
    field: c.field,
    value: c.from,
    message: `${c.from} → 自动改用服务器上的 ${c.to}`,
  }));
  const seenNodes = new Set<string>();
  for (const id of Object.keys(graph).sort(byNumericId)) {
    const node = graph[id];
    const def = info[node.class_type];
    if (!def) {
      if (!seenNodes.has(node.class_type)) {
        seenNodes.add(node.class_type);
        issues.push({ type: 'node', node: id, value: node.class_type, message: `缺少节点 ${node.class_type}（需要在 ComfyUI 里安装对应的自定义节点）` });
      }
      continue;
    }
    const loaderField = LOADERS[node.class_type]?.field;
    for (const [field, value] of Object.entries(node.inputs)) {
      if (field === loaderField || typeof value !== 'string') continue;
      const opts = comboOptions(def.input.required?.[field] ?? def.input.optional?.[field]);
      if (opts && opts.length && !opts.includes(value)) {
        issues.push({ type: 'file', node: id, field, value, options: opts, message: `缺少文件 ${value}（#${id} ${node.class_type}.${field}）` });
      }
    }
  }
  return issues;
}

/** Blocking problems only, one line each (for capability checks). */
export function validateGraph(graph: ComfyApiGraph, info: ObjectInfo): string[] {
  return graphIssues(graph, info)
    .filter((i) => i.type !== 'auto')
    .map((i) => (i.type === 'file' ? `模型 ${i.value}` : `节点 ${i.value}`));
}

/** Which way a text field feeds: into a "negative" input, a positive one, or neither. */
function textRole(graph: ComfyApiGraph, consumers: Map<string, { node: string; field: string }[]>, start: string): 'positive' | 'negative' | 'none' {
  const seen = new Set([start]);
  let frontier = [start];
  for (let depth = 0; depth < 10 && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const c of consumers.get(id) ?? []) {
        if (/negative/i.test(c.field)) return 'negative';
        if (/system/i.test(c.field)) return 'none';
        if (/^(positive|conditioning|cond)$/i.test(c.field)) return 'positive';
        // Entering an encoder that also has a negative field through any other field: positive side.
        if (Object.keys(graph[c.node]?.inputs ?? {}).some((f) => f !== c.field && /negative/i.test(f))) return 'positive';
        if (!seen.has(c.node)) {
          seen.add(c.node);
          next.push(c.node);
        }
      }
    }
    frontier = next;
  }
  return /TextEncode|ToVideo|Prompt/i.test(graph[start].class_type) ? 'positive' : 'none';
}

/** First-guess mapping for a freshly imported graph. */
export function detectWorkflow(graph: ComfyApiGraph, info?: ObjectInfo): Omit<WorkflowDraft, 'issues'> {
  const ids = Object.keys(graph).sort(byNumericId);
  const consumers = new Map<string, { node: string; field: string }[]>();
  for (const id of ids) {
    for (const [field, v] of Object.entries(graph[id].inputs)) {
      if (!isLink(v)) continue;
      const src = String(v[0]);
      if (!consumers.has(src)) consumers.set(src, []);
      consumers.get(src)!.push({ node: id, field });
    }
  }
  const tagged = (role: string) => ids.filter((id) => tagOf(graph[id])?.role === role);
  const inputs: WorkflowInput[] = [];

  // Prompt / negative prompt: any free-text field whose text ends up in conditioning.
  const textCandidates: { node: string; field: string; value: string; role: 'positive' | 'negative'; score: number }[] = [];
  for (const id of ids) {
    const node = graph[id];
    const title = node._meta?.title ?? '';
    if (/system/i.test(title) || LOADERS[node.class_type] || SAVERS.has(node.class_type)) continue;
    for (const [field, value] of Object.entries(node.inputs)) {
      if (typeof value !== 'string' || field.includes('.') || /^(filename_prefix|delimiter|format|codec|device|dtype|weight_dtype|type)$/.test(field)) continue;
      if (/system/i.test(field)) continue;
      if (comboOptions(info?.[node.class_type]?.input.required?.[field] ?? info?.[node.class_type]?.input.optional?.[field])) continue;
      const dual = Object.keys(node.inputs).some((f) => f !== field && /negative/i.test(f));
      const role = /negative/i.test(field) ? 'negative' : dual ? 'positive' : textRole(graph, consumers, id);
      if (role === 'none') continue;
      // Prefer fields that look like a prompt the user would write.
      const score = (/prompt/i.test(title) ? 4 : 0) + (TEXT_FIELD.test(field) ? 2 : 0) + (/TextEncode|ToVideo|Primitive/i.test(node.class_type) ? 1 : 0);
      textCandidates.push({ node: id, field, value, role, score });
    }
  }
  const pickText = (role: 'positive' | 'negative', tag: string) => {
    const pinned = tagged(tag).flatMap((id) => textCandidates.filter((c) => c.node === id));
    if (pinned.length) return pinned[0];
    const pool = textCandidates.filter((c) => c.role === role);
    return pool.sort((a, b) => b.score - a.score || b.value.length - a.value.length)[0];
  };
  // The same text is often wired into several places (a switch's direct path and a prompt
  // enhancer, say); every field holding it gets the user's prompt.
  const sameText = (pick: { node: string; field: string; value: string }) => {
    const spots = [{ node: pick.node, field: pick.field }];
    if (!pick.value.trim()) return spots;
    for (const id of ids) {
      for (const [field, value] of Object.entries(graph[id].inputs)) {
        if (value === pick.value && !(id === pick.node && field === pick.field)) spots.push({ node: id, field });
      }
    }
    return spots;
  };
  const prompt = pickText('positive', 'prompt');
  if (prompt) {
    sameText(prompt).forEach((s, i) =>
      inputs.push({ id: i ? `prompt${i + 1}` : 'prompt', type: 'prompt', node: s.node, field: s.field, label: '提示词', default: prompt.value }),
    );
  }
  const negative = pickText('negative', 'negative');
  if (negative && negative !== prompt) {
    sameText(negative).forEach((s, i) =>
      inputs.push({ id: i ? `negative${i + 1}` : 'negative', type: 'negative', node: s.node, field: s.field, label: '反向提示词', default: negative.value }),
    );
  }

  // Images, videos, masks.
  const counts = { image: 0, video: 0, mask: 0 };
  for (const id of ids) {
    const node = graph[id];
    const loader = LOADERS[node.class_type];
    if (!loader) continue;
    const tag = tagOf(node);
    if (tag && tag.role !== loader.type) continue;
    if (!tag && tagged(loader.type).length) continue;
    const n = ++counts[loader.type];
    const base = loader.type === 'image' ? '图' : loader.type === 'video' ? '视频' : '蒙版';
    inputs.push({
      id: `${loader.type}${n}`,
      type: loader.type,
      node: id,
      field: loader.field,
      label: tag?.label ?? customTitle(node, info) ?? (loader.type === 'mask' ? base : `${base}${n}`),
    });
  }

  // Seeds: every seed field gets the run's seed.
  let seeds = 0;
  for (const id of ids) {
    for (const [field, value] of Object.entries(graph[id].inputs)) {
      if (/^(seed|noise_seed)$/.test(field) && typeof value === 'number') {
        inputs.push({ id: `seed${++seeds}`, type: 'seed', node: id, field, label: '种子' });
      }
    }
  }

  // Ratio dropdowns (ResolutionSelector and friends) follow the composer's aspect setting.
  for (const id of ids) {
    const node = graph[id];
    for (const [field, value] of Object.entries(node.inputs)) {
      if (typeof value !== 'string' || !/aspect/i.test(field)) continue;
      const opts = comboOptions(info?.[node.class_type]?.input.required?.[field] ?? info?.[node.class_type]?.input.optional?.[field]);
      if (opts?.some((o) => /^\d+(\.\d+)?:\d+/.test(o)) && !inputs.some((i) => i.type === 'aspect')) {
        inputs.push({ id: 'aspect', type: 'aspect', node: id, field, label: '画面比例', default: value, options: opts });
      }
    }
  }

  // Knobs the author titled (Primitive* nodes like "Float (Duration)") become parameters.
  const taken = new Set(inputs.map((i) => `${i.node}.${i.field}`));
  for (const id of ids) {
    const node = graph[id];
    if (!/^Primitive(Int|Float|Boolean|String)$/.test(node.class_type)) continue;
    const title = customTitle(node, info);
    const value = node.inputs.value;
    if (!title || isLink(value) || taken.has(`${id}.value`)) continue;
    const type: WorkflowInput['type'] = typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'text';
    const label = title.replace(/^(Int|Float|Boolean|String)\s*\((.+)\)$/i, '$2').trim() || title;
    inputs.push({ id: uniqueParamId(label, inputs), type, node: id, field: 'value', label, default: value as string | number | boolean });
  }

  // Output size from the first empty latent / image with plain width & height.
  const sizeNode =
    tagged('size').find((id) => typeof graph[id].inputs.width === 'number') ??
    ids.find((id) => /Empty.*Latent|^EmptyImage$/.test(graph[id].class_type) && typeof graph[id].inputs.width === 'number' && typeof graph[id].inputs.height === 'number');
  if (sizeNode) {
    inputs.push({ id: 'width', type: 'width', node: sizeNode, field: 'width', label: '宽', default: graph[sizeNode].inputs.width as number });
    inputs.push({ id: 'height', type: 'height', node: sizeNode, field: 'height', label: '高', default: graph[sizeNode].inputs.height as number });
  }

  const outputCandidates = ids
    .filter((id) => {
      const t = graph[id].class_type;
      return SAVERS.has(t) || PREVIEWS.has(t) || (info?.[t]?.output_node && !NOT_RESULTS.has(t));
    })
    .map((id) => ({ node: id, classType: graph[id].class_type, title: graph[id]._meta?.title }));
  const pinnedOut = tagged('output');
  const savers = outputCandidates.filter((c) => SAVERS.has(c.classType)).map((c) => c.node);
  const outputs = pinnedOut.length ? pinnedOut : savers.length ? savers : outputCandidates.map((c) => c.node);
  const kind: MediaKind = outputs.some((id) => VIDEO_SAVERS.has(graph[id].class_type)) ? 'video' : 'image';

  return {
    workflow: { name: '', kind, graph, inputs, outputs },
    fields: listFields(graph, info),
    outputCandidates,
  };
}

function uniqueParamId(label: string, inputs: WorkflowInput[]) {
  const base = `p_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'param'}`;
  let id = base;
  for (let n = 2; inputs.some((i) => i.id === id); n++) id = `${base}_${n}`;
  return id;
}

// ------------------------------------------------------------------ portability

const PRECISION = new Set(['int8', 'int4', 'convrot', 'fp16', 'bf16', 'fp32', 'fp8', 'e4m3fn', 'e5m2', 'scaled', 'nvfp4', 'awq', 'mxfp8', 'fp4']);

/** Model name without folder, extension and precision tags: "x/wan_vae_fp16.safetensors" → "wan_vae". */
export function modelKey(name: string): string {
  const base = name.split('/').pop()!.toLowerCase().replace(/\.(safetensors|ckpt|pt|pth|bin|sft)$/, '');
  return base
    .split(/[_-]/)
    .filter((t) => t && !PRECISION.has(t))
    .join('_');
}

/**
 * Points model fields at files this server has: same file in a subfolder, or the same model
 * in another precision (int8 / bf16 / fp8…). Returns what was changed.
 */
export function fixModelPaths(graph: ComfyApiGraph, info: ObjectInfo): { node: string; field: string; from: string; to: string }[] {
  const changes: { node: string; field: string; from: string; to: string }[] = [];
  for (const [id, node] of Object.entries(graph)) {
    const def = info[node.class_type];
    if (!def) continue;
    const loaderField = LOADERS[node.class_type]?.field;
    for (const [field, value] of Object.entries(node.inputs)) {
      if (field === loaderField || typeof value !== 'string') continue;
      const opts = comboOptions(def.input.required?.[field] ?? def.input.optional?.[field]);
      if (!opts?.length || opts.includes(value)) continue;
      const base = value.split('/').pop()!.toLowerCase();
      const key = modelKey(value);
      const to = opts.find((o) => o.split('/').pop()!.toLowerCase() === base) ?? (key ? opts.find((o) => modelKey(o) === key) : undefined);
      if (to) {
        node.inputs[field] = to;
        changes.push({ node: id, field, from: value, to });
      }
    }
  }
  return changes;
}

/**
 * Resolves If/Else switches whose condition is fixed and drops nodes the outputs no longer
 * need, so unused branches (and their models) are not validated by ComfyUI.
 */
export function simplifyGraph(graph: ComfyApiGraph, outputs: string[]): ComfyApiGraph {
  const g: ComfyApiGraph = structuredClone(graph);
  const constant = (v: unknown): boolean | undefined => {
    if (typeof v === 'boolean') return v;
    if (isLink(v)) {
      const src = g[String(v[0])];
      if (src && src.class_type === 'PrimitiveBoolean' && typeof src.inputs.value === 'boolean') return src.inputs.value;
    }
    return undefined;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id, node] of Object.entries(g)) {
      if (node.class_type !== 'ComfySwitchNode') continue;
      const on = constant(node.inputs.switch);
      if (on === undefined) continue;
      const chosen = node.inputs[on ? 'on_true' : 'on_false'];
      if (chosen === undefined) continue;
      for (const other of Object.values(g)) {
        for (const [f, v] of Object.entries(other.inputs)) {
          if (isLink(v) && String(v[0]) === id) other.inputs[f] = chosen;
        }
      }
      delete g[id];
      changed = true;
    }
  }
  // Keep only what the outputs depend on.
  const keep = new Set<string>();
  const visit = (id: string) => {
    if (keep.has(id) || !g[id]) return;
    keep.add(id);
    for (const v of Object.values(g[id].inputs)) if (isLink(v)) visit(String(v[0]));
  };
  outputs.forEach(visit);
  for (const id of Object.keys(g)) if (!keep.has(id)) delete g[id];
  return g;
}

/** Keeps an edited mapping consistent with its graph. */
export function checkWorkflow(wf: Pick<CustomWorkflow, 'graph' | 'inputs' | 'outputs' | 'kind' | 'name'>): string | null {
  if (!wf.name?.trim()) return '请填写名称';
  if (!wf.outputs.length) return '请至少选择一个输出节点';
  for (const out of wf.outputs) if (!wf.graph[out]) return `输出节点 #${out} 不存在`;
  const keys = new Set<string>();
  for (const inp of wf.inputs) {
    if (!wf.graph[inp.node]) return `「${inp.label}」对应的节点 #${inp.node} 不存在`;
    if (!(inp.field in wf.graph[inp.node].inputs)) return `节点 #${inp.node} 没有字段 ${inp.field}`;
    if (keys.has(inp.id)) return `重复的输入 id: ${inp.id}`;
    keys.add(inp.id);
  }
  return null;
}

export interface CustomFiles {
  images: InputFile[];
  videos: InputFile[];
  mask?: InputFile;
}

/** Deletes a node and every input that was wired to it (only valid for optional inputs). */
function removeNode(graph: ComfyApiGraph, id: string) {
  delete graph[id];
  for (const node of Object.values(graph)) {
    for (const [f, v] of Object.entries(node.inputs)) if (isLink(v) && String(v[0]) === id) delete node.inputs[f];
  }
}

function slug(s: string) {
  return s.replace(/[^\w-]+/g, '_').slice(0, 40) || 'custom';
}

/** Fills a copy of the graph with the canvas inputs. */
export function buildCustom(wf: CustomWorkflow, req: Extract<TaskRequest, { op: 'custom' }>, files: CustomFiles, seed: number): BuiltWorkflow {
  const graph: ComfyApiGraph = structuredClone(wf.graph);
  const set = (inp: WorkflowInput, value: unknown) => {
    const node = graph[inp.node];
    if (!node) throw new Error(`工作流缺少节点 #${inp.node}`);
    node.inputs[inp.field] = value;
  };
  const of = (type: WorkflowInput['type']) => wf.inputs.filter((i) => i.type === type);

  const need = (type: 'image' | 'video', list: InputFile[]) => {
    const slots = of(type);
    const required = slots.filter((s) => !s.optional);
    if (list.length < required.length) {
      const what = type === 'image' ? '图片' : '视频';
      throw new Error(`「${wf.name}」需要 ${required.length} 个${what}输入（${required.map((s) => s.label).join('、')}），请先在画布上选中`);
    }
    slots.forEach((s, i) => {
      if (list[i]) set(s, list[i].comfyName);
      else removeNode(graph, s.node); // optional and not given
    });
  };
  need('image', files.images);
  need('video', files.videos);
  for (const m of of('mask')) {
    if (!files.mask) throw new Error(`「${wf.name}」需要蒙版`);
    set(m, files.mask.comfyName);
  }

  const prompt = req.prompt?.trim();
  if (prompt) of('prompt').forEach((i) => set(i, prompt));
  const negative = req.negative?.trim();
  if (negative) of('negative').forEach((i) => set(i, negative));
  // Seeds above 2^32 trip some custom nodes' limits.
  for (const s of of('seed')) set(s, seed % 4294967295);

  // Output size: keep the author's pixel budget, change the shape.
  let size: { width: number; height: number } | undefined;
  const [w] = of('width');
  const [h] = of('height');
  if (w && h) {
    const baseW = Number(graph[w.node]?.inputs[w.field]) || 1024;
    const baseH = Number(graph[h.node]?.inputs[h.field]) || 1024;
    const ratio = req.aspect && req.aspect !== 'auto' ? parseAspect(req.aspect) : files.images[0] ? files.images[0].width / files.images[0].height : null;
    size = ratio ? sizeForAspect(ratio, (baseW * baseH) / 2 ** 20, 32) : { width: baseW, height: baseH };
    set(w, size.width);
    set(h, size.height);
  }

  // Ratio dropdowns: pick the option closest to the requested (or first input's) shape.
  for (const a of of('aspect')) {
    const wanted = req.aspect && req.aspect !== 'auto' ? parseAspect(req.aspect) : files.images[0] ? files.images[0].width / files.images[0].height : null;
    if (!wanted || !a.options?.length) continue;
    let best: string | undefined;
    let bestDiff = Infinity;
    for (const o of a.options) {
      const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)/.exec(o);
      if (!m) continue;
      const diff = Math.abs(Math.log(Number(m[1]) / Number(m[2]) / wanted));
      if (diff < bestDiff) {
        bestDiff = diff;
        best = o;
      }
    }
    if (best) set(a, best);
  }

  for (const inp of wf.inputs) {
    if (!['number', 'text', 'select', 'boolean'].includes(inp.type)) continue;
    const raw = req.params?.[inp.id];
    if (raw === undefined || raw === '') continue;
    let value: unknown = raw;
    if (inp.type === 'number') {
      let n = Number(raw);
      if (!Number.isFinite(n)) continue;
      if (inp.min !== undefined) n = Math.max(inp.min, n);
      if (inp.max !== undefined) n = Math.min(inp.max, n);
      value = n;
    } else if (inp.type === 'boolean') value = raw === true || raw === 'true';
    else if (inp.type === 'select' && inp.options && !inp.options.includes(String(raw))) continue;
    else value = String(raw);
    set(inp, value);
  }

  // Keep results together in ComfyUI's output folder.
  for (const id of wf.outputs) {
    const node = graph[id];
    if (node && typeof node.inputs.filename_prefix === 'string') node.inputs.filename_prefix = `canva/${slug(wf.name)}`;
  }

  const first = files.images[0];
  const expectedSize = size ?? (first ? { width: first.width, height: first.height } : wf.kind === 'video' ? { width: 1280, height: 720 } : { width: 1024, height: 1024 });
  const stages: Stage[] = Object.keys(graph)
    .filter((id) => HEAVY.test(graph[id].class_type))
    .map((id) => ({ node: id, label: '生成中', weight: 1 }));

  return {
    graph,
    outputNodes: wf.outputs,
    expected: { kind: wf.kind, ...expectedSize },
    stages,
  };
}

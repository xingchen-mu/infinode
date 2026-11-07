import type { Capabilities, CustomWorkflow } from '../../shared/types.ts';
import { msg } from '../../shared/i18n.ts';
import { LICENSES, commercialBlock } from '../../shared/licenses.ts';
import { ComfyClient } from './client.ts';
import { PresetStore } from '../workflows/presets.ts';
import { SettingsStore } from '../settings.ts';
import { WorkflowStore } from '../workflows/store.ts';
import { fixModelPaths, validateGraph } from '../workflows/custom.ts';
import { REQUIREMENTS } from '../workflows/index.ts';
import { SLOTS, missingFor, missingSlots, resolveModels } from '../workflows/models.ts';
import { buildCatalog, slotDownload } from '../models/catalog.ts';
import { t } from '../i18n.ts';
import type { ModelDownload } from '../../shared/types.ts';

export type ObjectInfo = Awaited<ReturnType<ComfyClient['objectInfo']>>;
/** Listed with a template's missing parts when the GPU cannot run its fp8 models. */
export const FP8_NOTE = msg('fp8 模型（当前 GPU 在 --enable-triton-backend 下不支持 fp8，去掉该启动参数或换 bf16/int8 模型）');

/** What the connected ComfyUI can run; also picks model files for the built-in tools. */
export function createCapabilities(comfy: ComfyClient, workflows: WorkflowStore, presets: PresetStore, settings: SettingsStore) {
  let capsCache: { at: number; value: Capabilities; info: ObjectInfo } | undefined;
  let catalogCache: Map<string, ModelDownload> | undefined;
  /** Model files with a download link (from the templates, which the built-in tools share). */
  const catalog = () => (catalogCache ??= buildCatalog(presets.list().map((p) => p.models)));

  /** Built-in tools that cannot run for lack of model files: those files, where a download is known. */
  function downloads(features: Capabilities['features']): Record<string, ModelDownload[]> {
    const out: Record<string, ModelDownload[]> = {};
    for (const key of Object.keys(REQUIREMENTS)) {
      if (!features[key]?.length) continue;
      const files = missingSlots(key)
        .map((slot) => slotDownload(SLOTS[slot], catalog()))
        .filter((m): m is ModelDownload => Boolean(m));
      if (files.length) out[key] = [...new Map(files.map((m) => [m.name, m])).values()];
    }
    return out;
  }

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
        return fp8 ? [t(FP8_NOTE)] : [];
      };
      const features: Capabilities['features'] = {};
      for (const key of Object.keys(REQUIREMENTS)) features[key] = missingFor(key, info);
      for (const wf of [...workflows.list(), ...presets.list()]) features[`custom:${wf.id}`] = [...validateGraph(wf.graph, info), ...fp8Issue(wf.graph)];
      const value: Capabilities = {
        comfyOnline: true,
        comfyUrl: comfy.baseUrl,
        comfyVersion: stats.system.comfyui_version,
        gpu: stats.devices[0]?.name?.replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*cudaMallocAsync$/, ''),
        features: licensed(features),
        models: Object.fromEntries(Object.entries(models).filter(([, v]) => v)) as Record<string, string>,
        downloads: downloads(features),
      };
      capsCache = { at: Date.now(), value, info };
      return value;
    } catch {
      return {
        comfyOnline: false,
        comfyUrl: comfy.baseUrl,
        features: licensed(capsCache?.value.features ?? {}),
        models: capsCache?.value.models ?? {},
      };
    }
  }

  /** Commercial-only mode switches off research-only and non-commercial models, like a missing requirement. */
  function licensed(features: Capabilities['features']): Capabilities['features'] {
    if (!settings.value.commercialOnly) return features;
    const out = { ...features };
    for (const key of Object.keys(LICENSES)) {
      const block = commercialBlock(key);
      if (block && !out[key]?.includes(block)) out[key] = [...(out[key] ?? []), block];
    }
    return out;
  }

  /** /object_info when ComfyUI is reachable (used to type and check imported workflows). */
  async function objectInfo(): Promise<ObjectInfo | undefined> {
    await capabilities();
    return capsCache?.value.comfyUrl === comfy.baseUrl ? capsCache.info : undefined;
  }

  return {
    get: capabilities,
    catalog,
    objectInfo,
    cached: () => capsCache?.value,
    cachedObjectInfo: () => capsCache?.value.comfyUrl === comfy.baseUrl ? capsCache.info : undefined,
    invalidate: () => { capsCache = undefined; },
  };
}

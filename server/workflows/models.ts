import { t } from '../i18n.ts';
// Model files for the built-in tools. Each slot lists the usual file names (first match wins)
// plus a pattern, so different quantizations (int8 / bf16 / fp8) and subfolders are found.

export interface ModelSlot {
  /** Loader node and input whose dropdown lists the files. */
  node: string;
  input: string;
  candidates: string[];
  pattern?: RegExp;
  /** Tools still run without it (e.g. speed-up LoRAs). */
  optional?: boolean;
}

export const SLOTS = {
  'zimage.unet': { node: 'UNETLoader', input: 'unet_name', candidates: ['z_image_turbo_bf16.safetensors'], pattern: /z[_-]?image[_-]?turbo.*\.safetensors$/i },
  'zimage.clip': { node: 'CLIPLoader', input: 'clip_name', candidates: ['qwen_3_4b.safetensors'], pattern: /qwen[_-]?3[_-]?4b.*\.safetensors$/i },
  'zimage.vae': { node: 'VAELoader', input: 'vae_name', candidates: ['ae.safetensors'], pattern: /(^|\/)ae\.safetensors$/i },

  'qwen.unet': {
    node: 'UNETLoader',
    input: 'unet_name',
    candidates: ['qwen_image_2.1_int8_convrot.safetensors', 'qwen_image_2.1_bf16.safetensors', 'qwen_image_2.1_fp8_e4m3fn.safetensors'],
    pattern: /qwen[_-]image[_-]2\.1(?![_-]?(turbo|uc|vae))[^/]*\.safetensors$/i,
  },
  'qwen.clip': {
    node: 'CLIPLoader',
    input: 'clip_name',
    candidates: ['qwen3vl_8b_int8_convrot.safetensors', 'qwen3vl_8b_bf16.safetensors'],
    pattern: /qwen3[_-]?vl[_-]?8b.*\.safetensors$/i,
  },
  'qwen.vae': { node: 'VAELoader', input: 'vae_name', candidates: ['qwen_image_2.1_vae_bf16.safetensors'], pattern: /qwen[_-]image[_-]2\.1[_-]vae.*\.safetensors$/i },

  'seedvr2.dit': {
    node: 'SeedVR2LoadDiTModel',
    input: 'model',
    candidates: ['seedvr2_7b_fp8_e4m3fn.safetensors', 'seedvr2_ema_7b_fp16.safetensors', 'seedvr2_ema_7b_fp8_e4m3fn.safetensors', 'seedvr2_ema_3b_fp16.safetensors', 'seedvr2_ema_3b_fp8_e4m3fn.safetensors'],
  },
  'seedvr2.vae': { node: 'SeedVR2LoadVAEModel', input: 'model', candidates: ['ema_vae_fp16.safetensors'] },

  'minimax.fl2va': { node: 'UNETLoader', input: 'unet_name', candidates: ['minimax_h3_fl2va_pruned_int8_convrot.safetensors'], pattern: /minimax[_-]h3[_-]fl2va.*\.safetensors$/i },
  'minimax.ref2va': { node: 'UNETLoader', input: 'unet_name', candidates: ['minimax_h3_ref2va_pruned_int8_convrot.safetensors'], pattern: /minimax[_-]h3[_-]ref2va.*\.safetensors$/i },
  'minimax.clip': { node: 'CLIPLoader', input: 'clip_name', candidates: ['qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'], pattern: /qwen3[_-]?vl[_-]?32b[_-]minimax.*\.safetensors$/i },
  'minimax.videoVae': {
    node: 'VAELoader',
    input: 'vae_name',
    candidates: ['minimax_h3_video_vae_fp16.safetensors', 'minimax_h3_video_vae_int8_convrot.safetensors'],
    pattern: /minimax[_-]h3[_-]video[_-]vae.*\.safetensors$/i,
  },
  'minimax.audioVae': { node: 'VAELoader', input: 'vae_name', candidates: ['minimax_h3_audio_vae_fp32.safetensors'], pattern: /minimax[_-]h3[_-]audio[_-]vae.*\.safetensors$/i },
  'minimax.fl2vLora': {
    node: 'LoraLoaderModelOnly',
    input: 'lora_name',
    candidates: ['minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors'],
    pattern: /minimax[_-]h3[_-]fl2v[_-]turbo[_-]8step.*\.safetensors$/i,
    optional: true,
  },
  'minimax.ref2vLora': {
    node: 'LoraLoaderModelOnly',
    input: 'lora_name',
    candidates: ['minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors'],
    pattern: /minimax[_-]h3[_-]ref2v[_-]turbo.*\.safetensors$/i,
    optional: true,
  },
} satisfies Record<string, ModelSlot>;

export type SlotKey = keyof typeof SLOTS;

/** Files picked from the connected ComfyUI; empty string = not installed. */
const resolved: Partial<Record<SlotKey, string>> = {};

/** File for a slot ('' when an optional slot has nothing installed). */
export function model(key: SlotKey): string {
  return resolved[key] ?? SLOTS[key].candidates[0];
}

type ObjectInfo = Record<string, { input: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } }>;

export function comboOptions(spec: unknown[] | undefined): string[] | undefined {
  if (!spec) return undefined;
  if (Array.isArray(spec[0])) return (spec[0] as unknown[]).map(String);
  const opts = (spec[1] as { options?: unknown[] } | undefined)?.options;
  if (!Array.isArray(opts)) return undefined;
  // Dynamic combos list {key, inputs} objects.
  return opts.map((o) => (o && typeof o === 'object' && 'key' in o ? String((o as { key: unknown }).key) : String(o)));
}

export function inputSpec(info: ObjectInfo, node: string, input: string): unknown[] | undefined {
  const def = info[node];
  return def?.input.required?.[input] ?? def?.input.optional?.[input];
}

/** Picks a file for every slot from what the server has. Returns the picks. */
export function resolveModels(info: ObjectInfo): Partial<Record<SlotKey, string>> {
  for (const key of Object.keys(SLOTS) as SlotKey[]) {
    const slot: ModelSlot = SLOTS[key];
    const options = comboOptions(inputSpec(info, slot.node, slot.input)) ?? [];
    const exact = slot.candidates.find((c) => options.includes(c));
    const byPattern = slot.pattern ? options.find((o) => slot.pattern!.test(o)) : undefined;
    resolved[key] = exact ?? byPattern ?? '';
  }
  return { ...resolved };
}

export interface Requirement {
  nodes: string[];
  slots: SlotKey[];
}

const qwenNodes = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'TextEncodeQwenImage21', 'QwenImage21Cache'];
const qwenSlots: SlotKey[] = ['qwen.unet', 'qwen.clip', 'qwen.vae'];
const maskedNodes = [...qwenNodes, 'DifferentialDiffusion', 'SetLatentNoiseMask', 'ImageCompositeMasked', 'GrowMask', 'ImageBlur'];
const minimaxNodes = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'CreateVideo', 'SaveVideo', 'SamplerCustomAdvanced', 'VAEDecodeAudio'];

export const REQUIREMENTS: Record<string, Requirement> = {
  'image.generate:zimage': { nodes: ['UNETLoader', 'CLIPLoader', 'VAELoader', 'ModelSamplingAuraFlow'], slots: ['zimage.unet', 'zimage.clip', 'zimage.vae'] },
  'image.generate:qwen': { nodes: qwenNodes, slots: qwenSlots },
  'image.inpaint': { nodes: maskedNodes, slots: qwenSlots },
  'image.erase': { nodes: [...maskedNodes, 'EmptyImage', 'SolidMask', 'MaskComposite'], slots: qwenSlots },
  'image.outpaint': { nodes: [...maskedNodes, 'ImagePadForOutpaint'], slots: qwenSlots },
  'image.removeBg': { nodes: qwenNodes, slots: qwenSlots },
  'image.upscale': { nodes: ['SeedVR2LoadDiTModel', 'SeedVR2LoadVAEModel', 'SeedVR2VideoUpscaler'], slots: ['seedvr2.dit', 'seedvr2.vae'] },
  'video.generate:minimax': {
    nodes: [...minimaxNodes, 'MiniMaxH3ImageToVideo'],
    slots: ['minimax.fl2va', 'minimax.clip', 'minimax.videoVae', 'minimax.audioVae', 'minimax.fl2vLora'],
  },
  'video.generate:minimax-ref': {
    nodes: [...minimaxNodes, 'MiniMaxH3ReferenceToVideo'],
    slots: ['minimax.ref2va', 'minimax.clip', 'minimax.videoVae', 'minimax.audioVae', 'minimax.ref2vLora'],
  },
};

/** What a built-in tool is missing on the server (empty = ready). */
export function missingFor(key: string, info: ObjectInfo): string[] {
  const req = REQUIREMENTS[key];
  if (!req) return [];
  const missing = req.nodes.filter((n) => !info[n]).map((n) => t('节点 {name}', { name: n }));
  for (const slot of req.slots) {
    const s: ModelSlot = SLOTS[slot];
    if (!s.optional && !resolved[slot]) missing.push(t('模型 {name}', { name: s.candidates[0] }));
  }
  return missing;
}

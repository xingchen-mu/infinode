import { Graph, type BuiltWorkflow, type Handle, type InputFile, capPixels, snap } from './graph.ts';
import { model as modelFile } from './models.ts';

const PREFIX = 'infinode/';

// ---------------------------------------------------------------- Z-Image Turbo

export function zimageGenerate(p: { prompt: string; width: number; height: number; seed: number }): BuiltWorkflow {
  const g = new Graph();
  const unet = g.add('UNETLoader', { unet_name: modelFile('zimage.unet'), weight_dtype: 'default' });
  const clip = g.add('CLIPLoader', { clip_name: modelFile('zimage.clip'), type: 'lumina2', device: 'default' });
  const vae = g.add('VAELoader', { vae_name: modelFile('zimage.vae') });
  const model = g.add('ModelSamplingAuraFlow', { model: unet.out(), shift: 3 });
  const pos = g.add('CLIPTextEncode', { clip: clip.out(), text: p.prompt });
  const neg = g.add('ConditioningZeroOut', { conditioning: pos.out() });
  const latent = g.add('EmptySD3LatentImage', { width: p.width, height: p.height, batch_size: 1 });
  const ks = g.add('KSampler', {
    model: model.out(), positive: pos.out(), negative: neg.out(), latent_image: latent.out(),
    seed: p.seed, steps: 8, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1,
  });
  const dec = g.add('VAEDecode', { samples: ks.out(), vae: vae.out() });
  const save = g.add('SaveImage', { images: dec.out(), filename_prefix: PREFIX + 'zimage' });
  return {
    graph: g.nodes,
    outputNodes: [save.id],
    expected: { kind: 'image', width: p.width, height: p.height },
    stages: [{ node: ks.id, label: '生成中', weight: 1 }],
  };
}

// ---------------------------------------------------------------- Qwen Image 2.1

const QWEN_STEPS = 25;

function qwenBase(g: Graph) {
  const unet = g.add('UNETLoader', { unet_name: modelFile('qwen.unet'), weight_dtype: 'default' });
  const clip = g.add('CLIPLoader', { clip_name: modelFile('qwen.clip'), type: 'qwen_image', device: 'default' });
  const vae = g.add('VAELoader', { vae_name: modelFile('qwen.vae') });
  const model = g.add('QwenImage21Cache', { model: unet.out(), device: 'auto', dtype: 'default' });
  return { model, clip, vae };
}

/** Pixel budget side for TextEncodeQwenImage21's `resolution` (refs are resized to ~R×R). */
function refResolution(img: InputFile, maxSide: number): number {
  const side = Math.sqrt(img.width * img.height);
  return snap(Math.min(maxSide, Math.max(768, side)), 32);
}

/** Size TextEncodeQwenImage21 produces for image_1 at a given resolution. */
function qwenRefSize(img: InputFile, resolution: number) {
  const ratio = img.width / img.height;
  return {
    width: Math.max(32, Math.round(Math.sqrt(resolution * resolution * ratio) / 32) * 32),
    height: Math.max(32, Math.round(Math.sqrt((resolution * resolution) / ratio) / 32) * 32),
  };
}

function imageInputs(g: Graph, images: InputFile[], prefix: string) {
  const inputs: Record<string, unknown> = {};
  images.forEach((img, i) => {
    const load = g.add('LoadImage', { image: img.comfyName });
    inputs[`${prefix}${i + 1}`] = load.out(0);
  });
  return inputs;
}

/**
 * Text-to-image, or reference/edit generation when images are given.
 * With references and no explicit size, the output follows image_1 (best for edits).
 */
export function qwenGenerate(p: {
  prompt: string;
  seed: number;
  images: InputFile[];
  /** Explicit output size. Required without references. */
  size?: { width: number; height: number };
  /** Max side of the reference pixel budget. */
  maxSide: number;
  filenamePrefix?: string;
}): BuiltWorkflow {
  const g = new Graph();
  const { model, clip, vae } = qwenBase(g);
  let latent: unknown;
  let expected: { width: number; height: number };
  let enc;
  if (p.images.length === 0) {
    if (!p.size) throw new Error('size required for text-to-image');
    enc = g.add('TextEncodeQwenImage21', { clip: clip.out(), prompt: p.prompt, negative_prompt: '', resolution: 1024 });
    latent = g.add('EmptyLatentImage', { width: p.size.width, height: p.size.height, batch_size: 1 }).out();
    expected = p.size;
  } else {
    const resolution = refResolution(p.images[0], p.maxSide);
    enc = g.add('TextEncodeQwenImage21', {
      clip: clip.out(), prompt: p.prompt, negative_prompt: '', resolution, vae: vae.out(),
      ...imageInputs(g, p.images, 'images.image_'),
    });
    if (p.size) {
      latent = g.add('EmptyLatentImage', { width: p.size.width, height: p.size.height, batch_size: 1 }).out();
      expected = p.size;
    } else {
      latent = enc.out(2);
      expected = qwenRefSize(p.images[0], resolution);
    }
  }
  const ks = g.add('KSampler', {
    model: model.out(), positive: enc.out(0), negative: enc.out(1), latent_image: latent,
    seed: p.seed, steps: QWEN_STEPS, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
  });
  const dec = g.add('VAEDecode', { samples: ks.out(), vae: vae.out() });
  const save = g.add('SaveImage', { images: dec.out(), filename_prefix: PREFIX + (p.filenamePrefix ?? 'qwen') });
  return {
    graph: g.nodes,
    outputNodes: [save.id],
    expected: { kind: 'image', ...expected },
    stages: [{ node: ks.id, label: '生成中', weight: 1 }],
  };
}

export function qwenRemoveBackground(p: { image: InputFile; seed: number }): BuiltWorkflow {
  return qwenGenerate({
    prompt: 'Remove the background, and output a PNG image',
    seed: p.seed,
    images: [p.image],
    maxSide: 2048,
    filenamePrefix: 'cutout',
  });
}

/** Working size for masked edits: original aspect, at most ~2.5 MP, multiple of 32. */
function workSize(img: InputFile) {
  return capPixels(img.width, img.height, 2.5, 32);
}

/** Mask → slightly grown mask for sampling, plus a blurred copy for compositing. */
function prepareMask(g: Graph, mask: InputFile, grow: number) {
  const load = g.add('LoadImageMask', { image: mask.comfyName, channel: 'red' });
  const grown = g.add('GrowMask', { mask: load.out(), expand: grow, tapered_corners: true });
  const asImage = g.add('MaskToImage', { mask: grown.out() });
  const blurred = g.add('ImageBlur', { image: asImage.out(), blur_radius: 12, sigma: 6 });
  const soft = g.add('ImageToMask', { image: blurred.out(), channel: 'red' });
  return { grown, soft };
}

/** The original with a translucent red highlight over the mask, so the edit model can see the target area. */
function markRegion(g: Graph, image: InputFile, original: Handle, mask: Handle) {
  const red = g.add('EmptyImage', { width: image.width, height: image.height, batch_size: 1, color: 0xff0000 });
  const level = g.add('SolidMask', { value: 0.5, width: image.width, height: image.height });
  const alpha = g.add('MaskComposite', { destination: level.out(), source: mask.out(), x: 0, y: 0, operation: 'multiply' });
  return g.add('ImageCompositeMasked', {
    destination: original.out(0), source: red.out(), x: 0, y: 0, resize_source: false, mask: alpha.out(),
  });
}

/**
 * Masked edit: `refs[0]` is the edit target (image_1, also the starting latent), sampling is
 * restricted to the mask, and the result is pasted back onto the untouched original.
 */
function qwenMaskedEdit(
  g: Graph,
  p: { prompt: string; seed: number; image: InputFile; original: Handle; refs: unknown[]; mask: ReturnType<typeof prepareMask> },
  filenamePrefix: string,
): BuiltWorkflow {
  const { model, clip, vae } = qwenBase(g);
  const size = workSize(p.image);
  const scaled = p.refs.map((img) =>
    g.add('ImageScale', { image: img, upscale_method: 'lanczos', width: size.width, height: size.height, crop: 'disabled' }),
  );
  const refInputs: Record<string, unknown> = {};
  scaled.forEach((h, i) => (refInputs[`images.image_${i + 1}`] = h.out()));
  const enc = g.add('TextEncodeQwenImage21', {
    clip: clip.out(), prompt: p.prompt, negative_prompt: '', resolution: 0, vae: vae.out(), ...refInputs,
  });
  const encoded = g.add('VAEEncode', { pixels: scaled[0].out(), vae: vae.out() });
  const masked = g.add('SetLatentNoiseMask', { samples: encoded.out(), mask: p.mask.grown.out() });
  const diff = g.add('DifferentialDiffusion', { model: model.out(), strength: 1 });
  const ks = g.add('KSampler', {
    model: diff.out(), positive: enc.out(0), negative: enc.out(1), latent_image: masked.out(),
    seed: p.seed, steps: QWEN_STEPS, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
  });
  const dec = g.add('VAEDecode', { samples: ks.out(), vae: vae.out() });
  const comp = g.add('ImageCompositeMasked', {
    destination: p.original.out(0), source: dec.out(), x: 0, y: 0, resize_source: true, mask: p.mask.soft.out(),
  });
  const save = g.add('SaveImage', { images: comp.out(), filename_prefix: PREFIX + filenamePrefix });
  return {
    graph: g.nodes,
    outputNodes: [save.id],
    expected: { kind: 'image', width: p.image.width, height: p.image.height },
    stages: [{ node: ks.id, label: '重绘中', weight: 1 }],
  };
}

/** Flat gray over the mask: hides the old content so the model paints something new there. */
function grayOut(g: Graph, image: InputFile, original: Handle, mask: Handle) {
  const gray = g.add('EmptyImage', { width: image.width, height: image.height, batch_size: 1, color: 0x808080 });
  return g.add('ImageCompositeMasked', {
    destination: original.out(0), source: gray.out(), x: 0, y: 0, resize_source: false, mask: mask.out(),
  });
}

const inpaintPrompt = (t: string) =>
  `In <image1>, paint ${t} inside the flat gray area so that it fills the area, blending naturally with the surrounding scene. ` +
  'No gray should remain. Keep everything else unchanged.';

export function qwenInpaint(p: { image: InputFile; mask: InputFile; prompt: string; seed: number }): BuiltWorkflow {
  const g = new Graph();
  const original = g.add('LoadImage', { image: p.image.comfyName });
  const mask = prepareMask(g, p.mask, 8);
  const refs = [grayOut(g, p.image, original, mask.grown).out()];
  return qwenMaskedEdit(g, { ...p, prompt: inpaintPrompt(p.prompt), original, refs, mask }, 'inpaint');
}

// Erasing works best when the model sees the object (so it knows what to remove) plus a marked copy.
const ERASE_PROMPT =
  '<image2> is <image1> with one area highlighted in red. Remove the object inside that highlighted area from <image1>, ' +
  'filling the area naturally with the surrounding background as if it had never been there. Keep everything else unchanged.';

export function qwenErase(p: { image: InputFile; mask: InputFile; seed: number }): BuiltWorkflow {
  const g = new Graph();
  const original = g.add('LoadImage', { image: p.image.comfyName });
  const mask = prepareMask(g, p.mask, 12);
  const refs = [original.out(0), markRegion(g, p.image, original, mask.grown).out()];
  return qwenMaskedEdit(g, { ...p, prompt: ERASE_PROMPT, original, refs, mask }, 'erase');
}

// The padded copy is image_1; telling the model the gray is blank canvas makes it paint over it.
const OUTPAINT_PROMPT =
  'The flat gray areas around <image1> are blank canvas, not part of the picture. Replace all of the gray with a natural ' +
  'continuation of the scene, matching its style, lighting, colors and perspective, so the result is one seamless full-frame ' +
  'image with no gray borders. Keep the original area unchanged.';

/** Splits a padded axis into multiples of 8 whose total is a multiple of 32. */
function padAxis(src: number, a: number, b: number, scale: number) {
  if (a <= 0 && b <= 0) return { src: snap(src * scale, 32), a: 0, b: 0 };
  const s = snap(src * scale, 8);
  let pa = a > 0 ? snap(a * scale, 8) : 0;
  let pb = b > 0 ? snap(b * scale, 8) : 0;
  const rem = (32 - ((s + pa + pb) % 32)) % 32;
  if (pa >= pb) pa += rem;
  else pb += rem;
  return { src: s, a: pa, b: pb };
}

export function qwenOutpaint(p: {
  image: InputFile;
  left: number;
  top: number;
  right: number;
  bottom: number;
  prompt?: string;
  seed: number;
}): BuiltWorkflow {
  const totalW = p.image.width + p.left + p.right;
  const totalH = p.image.height + p.top + p.bottom;
  const px = totalW * totalH;
  const target = Math.min(Math.max(px, 1.0 * 1024 * 1024), 2.5 * 1024 * 1024);
  const scale = Math.sqrt(target / px);
  const x = padAxis(p.image.width, p.left, p.right, scale);
  const y = padAxis(p.image.height, p.top, p.bottom, scale);
  const width = x.src + x.a + x.b;
  const height = y.src + y.a + y.b;

  const g = new Graph();
  const { model, clip, vae } = qwenBase(g);
  const original = g.add('LoadImage', { image: p.image.comfyName });
  const scaled = g.add('ImageScale', { image: original.out(0), upscale_method: 'lanczos', width: x.src, height: y.src, crop: 'disabled' });
  const padded = g.add('ImagePadForOutpaint', {
    image: scaled.out(), left: x.a, top: y.a, right: x.b, bottom: y.b, feathering: 64,
  });
  const prompt = p.prompt?.trim() ? `${OUTPAINT_PROMPT} The newly revealed areas show: ${p.prompt.trim()}` : OUTPAINT_PROMPT;
  const enc = g.add('TextEncodeQwenImage21', {
    clip: clip.out(), prompt, negative_prompt: '', resolution: 0, vae: vae.out(), 'images.image_1': padded.out(0),
  });
  const encoded = g.add('VAEEncode', { pixels: padded.out(0), vae: vae.out() });
  const masked = g.add('SetLatentNoiseMask', { samples: encoded.out(), mask: padded.out(1) });
  const diff = g.add('DifferentialDiffusion', { model: model.out(), strength: 1 });
  const ks = g.add('KSampler', {
    model: diff.out(), positive: enc.out(0), negative: enc.out(1), latent_image: masked.out(),
    seed: p.seed, steps: QWEN_STEPS, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
  });
  const dec = g.add('VAEDecode', { samples: ks.out(), vae: vae.out() });
  const save = g.add('SaveImage', { images: dec.out(), filename_prefix: PREFIX + 'outpaint' });
  return {
    graph: g.nodes,
    outputNodes: [save.id],
    expected: { kind: 'image', width, height },
    stages: [{ node: ks.id, label: '扩图中', weight: 1 }],
  };
}

// ---------------------------------------------------------------- SeedVR2 upscale

const MAX_UPSCALE_EDGE = 4096;

export function seedvr2Upscale(p: { image: InputFile & { hasAlpha?: boolean }; scale: number; seed: number }): BuiltWorkflow {
  const { width: w, height: h } = p.image;
  const factor = Math.min(p.scale, MAX_UPSCALE_EDGE / Math.max(w, h));
  const outW = Math.round((w * factor) / 2) * 2;
  const outH = Math.round((h * factor) / 2) * 2;
  const g = new Graph();
  const src = g.add('LoadImage', { image: p.image.comfyName });
  const input = p.image.hasAlpha ? g.add('JoinImageWithAlpha', { image: src.out(0), alpha: src.out(1) }).out() : src.out(0);
  const dit = g.add('SeedVR2LoadDiTModel', {
    model: modelFile('seedvr2.dit'), device: 'cuda:0', blocks_to_swap: 0, swap_io_components: false,
    offload_device: 'cpu', cache_model: false, attention_mode: 'sdpa',
  });
  const vae = g.add('SeedVR2LoadVAEModel', {
    model: modelFile('seedvr2.vae'), device: 'cuda:0',
    encode_tiled: true, encode_tile_size: 1024, encode_tile_overlap: 128,
    decode_tiled: true, decode_tile_size: 1024, decode_tile_overlap: 128,
    tile_debug: 'false', offload_device: 'cpu', cache_model: false,
  });
  const up = g.add('SeedVR2VideoUpscaler', {
    image: input, dit: dit.out(), vae: vae.out(), seed: p.seed % 4294967295,
    resolution: Math.min(outW, outH), max_resolution: MAX_UPSCALE_EDGE, batch_size: 1, uniform_batch_size: false,
    color_correction: 'lab', temporal_overlap: 0, prepend_frames: 0, input_noise_scale: 0, latent_noise_scale: 0,
    offload_device: 'cpu', enable_debug: false,
  });
  const save = g.add('SaveImage', { images: up.out(), filename_prefix: PREFIX + 'upscale' });
  return {
    graph: g.nodes,
    outputNodes: [save.id],
    expected: { kind: 'image', width: outW, height: outH },
    stages: [{ node: up.id, label: '超清中', weight: 1 }],
  };
}

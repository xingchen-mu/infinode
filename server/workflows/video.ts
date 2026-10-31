import { Graph, type BuiltWorkflow, type InputFile } from './graph.ts';
import { model as modelFile } from './models.ts';

const PREFIX = 'infinode/';

function saveVideo(g: Graph, video: unknown, name: string) {
  return g.add('SaveVideo', { video, filename_prefix: PREFIX + name, format: 'auto', 'format.codec': 'auto' });
}

// ---------------------------------------------------------------- MiniMax H3 (video + audio)

const MINIMAX_FPS = 24;

/** MiniMax frame counts sit on a 17k+5 grid at 24 fps. */
export function minimaxLength(seconds: number): number {
  const l = Math.max(5, Math.round(seconds * MINIMAX_FPS));
  return l + ((5 - (l % 17)) % 17 + 17) % 17;
}

/** Diffusion model, with the turbo LoRA when installed (fewer steps); 20 steps without it. */
function minimaxModel(g: Graph, unetName: string, loraName: string, loraSteps: number) {
  const unet = g.add('UNETLoader', { unet_name: unetName, weight_dtype: 'default' });
  if (!loraName) return { diffusion: unet.out(), steps: 20 };
  const lora = g.add('LoraLoaderModelOnly', { model: unet.out(), lora_name: loraName, strength_model: 1 });
  return { diffusion: lora.out(), steps: loraSteps };
}

function minimaxSample(
  g: Graph,
  model: unknown,
  conditioning: unknown,
  latent: unknown,
  steps: number,
  scheduler: string,
  seed: number,
  videoVae: unknown,
  audioVae: unknown,
) {
  const noise = g.add('RandomNoise', { noise_seed: seed });
  const guider = g.add('BasicGuider', { model, conditioning });
  const sampler = g.add('KSamplerSelect', { sampler_name: 'res_multistep' });
  const sigmas = g.add('BasicScheduler', { model, scheduler, steps, denoise: 1 });
  const s = g.add('SamplerCustomAdvanced', { noise: noise.out(), guider: guider.out(), sampler: sampler.out(), sigmas: sigmas.out(), latent_image: latent });
  const dec = g.add('VAEDecode', { samples: s.out(0), vae: videoVae });
  const audio = g.add('VAEDecodeAudio', { samples: s.out(0), vae: audioVae });
  const video = g.add('CreateVideo', { images: dec.out(), audio: audio.out(), fps: MINIMAX_FPS });
  return { s, dec, video };
}

/** Text-to-video, first-frame, last-frame or first+last-frame video with audio. */
export function minimaxGenerate(p: {
  prompt: string;
  width: number;
  height: number;
  seconds: number;
  seed: number;
  first?: InputFile;
  last?: InputFile;
}): BuiltWorkflow {
  const g = new Graph();
  const { diffusion, steps } = minimaxModel(g, modelFile('minimax.fl2va'), modelFile('minimax.fl2vLora'), 8);
  const clip = g.add('CLIPLoader', { clip_name: modelFile('minimax.clip'), type: 'minimax', device: 'default' });
  const videoVae = g.add('VAELoader', { vae_name: modelFile('minimax.videoVae') });
  const audioVae = g.add('VAELoader', { vae_name: modelFile('minimax.audioVae') });
  const cond = g.add('MiniMaxH3ImageToVideo', {
    clip: clip.out(), vae: videoVae.out(), prompt: p.prompt, width: p.width, height: p.height, length: minimaxLength(p.seconds),
    ...(p.first ? { first_frame: g.add('LoadImage', { image: p.first.comfyName }).out(0) } : {}),
    ...(p.last ? { last_frame: g.add('LoadImage', { image: p.last.comfyName }).out(0) } : {}),
  });
  const { s, dec, video } = minimaxSample(g, diffusion, cond.out(0), cond.out(1), steps, 'simple', p.seed, videoVae.out(), audioVae.out());
  const save = saveVideo(g, video.out(), 'minimax');
  return {
    graph: g.nodes,
    outputNodes: [save.id],
    expected: { kind: 'video', width: p.width, height: p.height },
    stages: [
      { node: cond.id, label: '理解提示词与画面', weight: 0.3 },
      { node: s.id, label: '生成中', weight: 0.55 },
      { node: dec.id, label: '解码中', weight: 0.15 },
    ],
  };
}

/** Reference-to-video: characters/objects/styles from up to 9 reference images. */
export function minimaxReference(p: {
  prompt: string;
  width: number;
  height: number;
  seconds: number;
  seed: number;
  images: InputFile[];
}): BuiltWorkflow {
  const g = new Graph();
  const { diffusion, steps } = minimaxModel(g, modelFile('minimax.ref2va'), modelFile('minimax.ref2vLora'), 4);
  const clip = g.add('CLIPLoader', { clip_name: modelFile('minimax.clip'), type: 'minimax', device: 'default' });
  const videoVae = g.add('VAELoader', { vae_name: modelFile('minimax.videoVae') });
  const audioVae = g.add('VAELoader', { vae_name: modelFile('minimax.audioVae') });
  const refs: Record<string, unknown> = {};
  p.images.slice(0, 9).forEach((img, i) => {
    refs[`ref_images.ref_image_${i}`] = g.add('LoadImage', { image: img.comfyName }).out(0);
  });
  const cond = g.add('MiniMaxH3ReferenceToVideo', {
    clip: clip.out(), vae: videoVae.out(), audio_vae: audioVae.out(), prompt: p.prompt,
    width: p.width, height: p.height, length: minimaxLength(p.seconds), ref_image_size: 'match', ...refs,
  });
  const { s, dec, video } = minimaxSample(g, diffusion, cond.out(0), cond.out(1), steps, 'beta', p.seed, videoVae.out(), audioVae.out());
  const save = saveVideo(g, video.out(), 'minimax_ref');
  return {
    graph: g.nodes,
    outputNodes: [save.id],
    expected: { kind: 'video', width: p.width, height: p.height },
    stages: [
      { node: cond.id, label: '理解参考图', weight: 0.3 },
      { node: s.id, label: '生成中', weight: 0.55 },
      { node: dec.id, label: '解码中', weight: 0.15 },
    ],
  };
}

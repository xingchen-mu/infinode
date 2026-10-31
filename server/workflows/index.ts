import type { CustomWorkflow, TaskRequest } from '../../shared/types.ts';
import { buildCustom } from './custom.ts';
import { type BuiltWorkflow, type InputFile, fitPixels, parseAspect, sizeForAspect } from './graph.ts';
import { qwenErase, qwenGenerate, qwenInpaint, qwenOutpaint, qwenRemoveBackground, seedvr2Upscale, zimageGenerate } from './image.ts';
import { REQUIREMENTS } from './models.ts';
import { minimaxGenerate, minimaxReference } from './video.ts';

export { REQUIREMENTS };

export class RequestError extends Error {}

export interface ResolvedFiles {
  images: (InputFile & { hasAlpha?: boolean })[];
  videos?: InputFile[];
  mask?: InputFile;
}

/** Which capability (see REQUIREMENTS) a request needs. */
export function featureKey(req: TaskRequest): string {
  switch (req.op) {
    case 'image.generate':
      return `image.generate:${req.model}`;
    case 'video.generate':
      return `video.generate:${req.model}`;
    case 'custom':
      return `custom:${req.workflow}`;
    default:
      return req.op;
  }
}

/** Asset ids a request reads, in order. */
export function requestAssets(req: TaskRequest): { images: string[]; videos: string[]; mask?: string } {
  switch (req.op) {
    case 'image.generate':
    case 'video.generate':
      return { images: req.images ?? [], videos: [] };
    case 'custom':
      return { images: req.images ?? [], videos: req.videos ?? [], mask: req.mask };
    case 'image.inpaint':
    case 'image.erase':
      return { images: [req.image], videos: [], mask: req.mask };
    default:
      return { images: [req.image], videos: [] };
  }
}

/** Users write "@图1" (or "图1", "@image1"); each model has its own tag. */
export function convertImageRefs(prompt: string, style: 'qwen' | 'minimax'): string {
  return prompt.replace(/@?(?:图片?|image|img|picture)\s*(\d+)/gi, (_, n: string) =>
    style === 'qwen' ? `<image${n}>` : `<Picture ${n}>`,
  );
}

const IMAGE_MP = { '1k': 1.0, '2k': { zimage: 2.25, qwen: 4.0 } } as const;
// MiniMax H3's native canvas is 768p (1344×768 at 16:9).
const VIDEO_MP = { '480p': 0.4, '720p': 0.98 } as const;

function clampText(s: string | undefined, max = 4000) {
  return (s ?? '').trim().slice(0, max);
}

function requirePrompt(s: string | undefined) {
  const t = clampText(s);
  if (!t) throw new RequestError('请输入提示词');
  return t;
}

function aspectOrNull(aspect: string | undefined): number | null {
  if (!aspect || aspect === 'auto') return null;
  const r = parseAspect(aspect);
  if (!r || r < 0.2 || r > 5) throw new RequestError(`无效的画面比例: ${aspect}`);
  return r;
}

export function buildWorkflow(
  req: TaskRequest,
  files: ResolvedFiles,
  seed: number,
  getWorkflow: (id: string) => CustomWorkflow | undefined,
): BuiltWorkflow {
  const [first] = files.images;
  switch (req.op) {
    case 'custom': {
      const wf = getWorkflow(req.workflow);
      if (!wf) throw new RequestError('这个工作流已被删除');
      try {
        return buildCustom(wf, { ...req, prompt: clampText(req.prompt), negative: clampText(req.negative) }, { images: files.images, videos: files.videos ?? [], mask: files.mask }, seed);
      } catch (err) {
        throw new RequestError((err as Error).message);
      }
    }
    case 'image.generate': {
      const prompt = requirePrompt(req.prompt);
      const ratio = aspectOrNull(req.aspect);
      const quality = req.quality === '2k' ? '2k' : '1k';
      if (req.model === 'zimage') {
        const mp = quality === '2k' ? IMAGE_MP['2k'].zimage : IMAGE_MP['1k'];
        const size = sizeForAspect(ratio ?? (first ? first.width / first.height : 1), mp, 32);
        return zimageGenerate({ prompt, seed, ...size });
      }
      if (req.model === 'qwen') {
        const mp = quality === '2k' ? IMAGE_MP['2k'].qwen : IMAGE_MP['1k'];
        const images = files.images.slice(0, 10);
        const size = ratio ? sizeForAspect(ratio, mp, 32) : images.length ? undefined : sizeForAspect(1, mp, 32);
        return qwenGenerate({
          prompt: images.length ? convertImageRefs(prompt, 'qwen') : prompt,
          seed,
          images,
          size,
          maxSide: quality === '2k' ? 2048 : 1024,
        });
      }
      throw new RequestError(`未知图片模型: ${String((req as { model: unknown }).model)}`);
    }
    case 'image.inpaint':
      if (!first || !files.mask) throw new RequestError('缺少图片或蒙版');
      return qwenInpaint({ image: first, mask: files.mask, prompt: requirePrompt(req.prompt), seed });
    case 'image.erase':
      if (!first || !files.mask) throw new RequestError('缺少图片或蒙版');
      return qwenErase({ image: first, mask: files.mask, seed });
    case 'image.outpaint': {
      if (!first) throw new RequestError('缺少图片');
      const pads = [req.left, req.top, req.right, req.bottom].map((v) => Math.max(0, Math.round(Number(v) || 0)));
      if (pads.every((v) => v === 0)) throw new RequestError('请拖动边框设置扩展范围');
      const [left, top, right, bottom] = pads;
      return qwenOutpaint({ image: first, left, top, right, bottom, prompt: clampText(req.prompt), seed });
    }
    case 'image.removeBg':
      if (!first) throw new RequestError('缺少图片');
      return qwenRemoveBackground({ image: first, seed });
    case 'image.upscale': {
      if (!first) throw new RequestError('缺少图片');
      const scale = Math.min(4, Math.max(1.25, Number(req.scale) || 2));
      return seedvr2Upscale({ image: first, scale, seed });
    }
    case 'video.generate': {
      const prompt = requirePrompt(req.prompt);
      const ratio = aspectOrNull(req.aspect);
      const quality = req.quality === '720p' ? '720p' : '480p';
      const [, second] = files.images;
      if (req.model === 'minimax' || req.model === 'minimax-ref') {
        const seconds = Math.min(15, Math.max(2, Number(req.duration) || 5));
        const mp = VIDEO_MP[quality];
        if (req.model === 'minimax-ref') {
          if (!files.images.length) throw new RequestError('多图参考需要至少一张参考图');
          const size = sizeForAspect(ratio ?? first.width / first.height, mp, 32);
          return minimaxReference({ prompt: convertImageRefs(prompt, 'minimax'), seconds, seed, images: files.images, ...size });
        }
        const size = ratio ? sizeForAspect(ratio, mp, 32) : first ? fitPixels(first.width, first.height, mp, 32) : sizeForAspect(16 / 9, mp, 32);
        return minimaxGenerate({
          prompt: first ? convertImageRefs(prompt, 'minimax') : prompt,
          seconds,
          seed,
          ...size,
          first,
          last: second,
        });
      }
      throw new RequestError(`未知视频模型: ${String((req as { model: unknown }).model)}`);
    }
    default:
      throw new RequestError(`未知操作: ${(req as { op: string }).op}`);
  }
}

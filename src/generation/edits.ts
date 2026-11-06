import type { CanvasItem, TaskRequest } from '../../shared/types';
import { api } from '../lib/api';
import { type Rect } from '../../shared/geometry';
import { launch } from './tasks';

function sameSize(item: CanvasItem) {
  return { w: item.w, h: item.h };
}

export function upscale(item: CanvasItem, scale: number) {
  if (!item.asset) return;
  return launch({ request: { op: 'image.upscale', image: item.asset.id, scale }, kind: 'image', size: sameSize(item), inputs: [item] });
}

export function removeBackground(item: CanvasItem) {
  if (!item.asset) return;
  return launch({ request: { op: 'image.removeBg', image: item.asset.id }, kind: 'image', size: sameSize(item), inputs: [item] });
}

export async function maskedEdit(item: CanvasItem, kind: 'inpaint' | 'erase', mask: Blob, prompt: string) {
  if (!item.asset) return;
  const maskAsset = await api.uploadAsset(mask, 'mask.png');
  const request: TaskRequest =
    kind === 'inpaint'
      ? { op: 'image.inpaint', image: item.asset.id, mask: maskAsset.id, prompt }
      : { op: 'image.erase', image: item.asset.id, mask: maskAsset.id };
  return launch({ request, kind: 'image', size: sameSize(item), inputs: [item] });
}

/** `frame` is the expanded area in board units, containing the item. */
export function outpaint(item: CanvasItem, frame: Rect, prompt: string) {
  if (!item.asset) return;
  const k = item.asset.width / item.w;
  const pad = (v: number) => Math.max(0, Math.round(v * k));
  return launch({
    request: {
      op: 'image.outpaint',
      image: item.asset.id,
      left: pad(item.x - frame.x),
      top: pad(item.y - frame.y),
      right: pad(frame.x + frame.w - (item.x + item.w)),
      bottom: pad(frame.y + frame.h - (item.y + item.h)),
      prompt,
    },
    kind: 'image',
    size: { w: frame.w, h: frame.h },
    inputs: [item],
  });
}

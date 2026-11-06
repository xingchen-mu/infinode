import { nanoid } from 'nanoid';
import type { AssetInfo, CanvasItem } from '../../shared/types';
import { commit, select, toast, useStore } from '../store';
import { api } from '../lib/api';
import { GAP, boundsOf, displaySize, placeRow, viewportCenter } from '../../shared/geometry';
import { t } from '../i18n';
import { IMAGE_LONG_SIDE, VIDEO_LONG_SIDE } from '../canvas/items';
import { ensureVisible } from '../canvas/view';

const get = useStore.getState;

function videoSize(file: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      resolve({ width: v.videoWidth || 1280, height: v.videoHeight || 720 });
      URL.revokeObjectURL(url);
    };
    v.onerror = () => {
      resolve({ width: 1280, height: 720 });
      URL.revokeObjectURL(url);
    };
    v.src = url;
  });
}

function sizeFor(asset: AssetInfo) {
  return displaySize(asset.width || 1, asset.height || 1, asset.kind === 'video' ? VIDEO_LONG_SIDE : IMAGE_LONG_SIDE);
}

/** Uploads files and drops them on the board (centered on `at`, or at the view center). */
export async function addFiles(files: File[], at?: { x: number; y: number }) {
  const media = files.filter((f) => /^(image|video)\//.test(f.type));
  if (!media.length) {
    if (files.length) toast(t('只支持图片和视频文件'), 'error');
    return;
  }
  const assets: AssetInfo[] = [];
  for (const f of media) {
    try {
      const size = f.type.startsWith('video/') ? await videoSize(f) : undefined;
      assets.push(await api.uploadAsset(f, f.name || 'pasted.png', size));
    } catch (err) {
      toast(t('{name} 上传失败：{message}', { name: f.name, message: (err as Error).message }), 'error');
    }
  }
  if (assets.length) addAssets(assets, at);
}

export function addAssets(assets: AssetInfo[], at?: { x: number; y: number }, source?: CanvasItem) {
  const { items, viewport, screen } = get();
  const sizes = assets.map(sizeFor);
  let positions: { x: number; y: number }[];
  if (source) {
    positions = placeRow(items, { x: source.x + source.w + GAP, y: source.y }, sizes);
  } else if (at) {
    let x = at.x - sizes[0].w / 2;
    positions = sizes.map((s) => {
      const p = { x, y: at.y - s.h / 2 };
      x += s.w + GAP;
      return p;
    });
  } else {
    const c = viewportCenter(viewport, screen.w, screen.h - 160);
    const rowW = sizes.reduce((s, r) => s + r.w, 0) + GAP * (sizes.length - 1);
    positions = placeRow(items, { x: c.x - rowW / 2, y: c.y - sizes[0].h / 2 }, sizes);
  }
  const now = Date.now();
  const added: CanvasItem[] = assets.map((asset, i) => ({
    id: nanoid(10),
    kind: asset.kind,
    x: Math.round(positions[i].x),
    y: Math.round(positions[i].y),
    ...sizes[i],
    asset,
    name: asset.name,
    inputs: source ? [source.id] : undefined,
    createdAt: now,
  }));
  commit([...items, ...added]);
  select(added.map((a) => a.id));
  ensureVisible(boundsOf(added)!);
  return added;
}
export function download(item: CanvasItem) {
  if (!item.asset) return;
  const ext = item.asset.url.split('.').pop();
  const a = document.createElement('a');
  a.href = item.asset.url;
  a.download = `infinode-${item.id}.${ext}`;
  a.click();
}
/** Saves the frame currently shown by a video item as a new image next to it. */
export async function captureFrame(item: CanvasItem) {
  const video = document.querySelector<HTMLVideoElement>(`[data-item-id="${item.id}"] video`);
  if (!video || !video.videoWidth) return toast(t('视频还没加载好'), 'info');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d')!.drawImage(video, 0, 0);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) return;
  const asset = await api.uploadAsset(blob, `frame-${Math.round(video.currentTime * 1000)}ms.png`);
  addAssets([asset], undefined, item);
  toast(t('已截取当前帧'), 'success');
}

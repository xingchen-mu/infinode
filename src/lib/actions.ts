import { nanoid } from 'nanoid';
import type { AssetInfo, CanvasItem, ImageModel, MediaKind, TaskRequest, VideoModel, WorkflowLike } from '../../shared/types';
import { applyTask, commit, removeItems, select, setViewport, setWorkflows, toast, updateItems, useStore } from '../store';
import { api } from './api';
import { GAP, type Rect, boundsOf, displaySize, fitViewport, placeRow, toScreen, viewportCenter } from './geometry';
import { VIDEO_DURATIONS, aspectValue } from './models';

const get = useStore.getState;

export const IMAGE_LONG_SIDE = 512;
export const VIDEO_LONG_SIDE = 640;

// ------------------------------------------------------------------ view helpers

/** Pans (and zooms out if needed) so `r` is on screen. */
export function ensureVisible(r: Rect) {
  const { viewport: v, screen } = get();
  const s = toScreen(v, r);
  const margin = 60;
  const bottomUi = 220;
  if (s.x >= margin && s.y >= margin && s.x + s.w <= screen.w - margin && s.y + s.h <= screen.h - bottomUi) return;
  const fits = s.w <= screen.w - margin * 2 && s.h <= screen.h - margin - bottomUi;
  if (fits) {
    setViewport({ ...v, x: screen.w / 2 - (r.x + r.w / 2) * v.zoom, y: (screen.h - bottomUi + margin) / 2 - (r.y + r.h / 2) * v.zoom });
  } else {
    const fit = fitViewport(r, screen.w, screen.h - bottomUi + margin, 60, v.zoom);
    setViewport({ ...fit, y: fit.y - (bottomUi - margin) / 2 });
  }
}

export function fitAll() {
  const { items, screen } = get();
  const b = boundsOf(items);
  if (!b) return setViewport({ x: screen.w / 2, y: screen.h / 2 - 80, zoom: 1 });
  const fit = fitViewport(b, screen.w, screen.h - 160, 80, 1);
  setViewport({ ...fit, y: fit.y - 60 });
}

// ------------------------------------------------------------------ media files

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
    if (files.length) toast('只支持图片和视频文件', 'error');
    return;
  }
  const assets: AssetInfo[] = [];
  for (const f of media) {
    try {
      const size = f.type.startsWith('video/') ? await videoSize(f) : undefined;
      assets.push(await api.uploadAsset(f, f.name || 'pasted.png', size));
    } catch (err) {
      toast(`${f.name} 上传失败：${(err as Error).message}`, 'error');
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

// ------------------------------------------------------------------ tasks

/** Applies a patch to an item in the board and in the undo history. */
function patchEverywhere(id: string, patch: Partial<CanvasItem>) {
  const fix = (list: CanvasItem[]) => (list.some((i) => i.id === id) ? list.map((i) => (i.id === id ? { ...i, ...patch } : i)) : list);
  const { items, past, future } = get();
  useStore.setState({ items: fix(items), past: past.map(fix), future: future.map(fix) });
}

async function submit(item: CanvasItem, request: TaskRequest) {
  // The id is chosen here and stored first, so a reload mid-submit still finds the task.
  const taskId = nanoid(10);
  patchEverywhere(item.id, { taskId, resultIndex: 0, error: undefined });
  try {
    const task = await api.createTask(request, taskId);
    // Correct the placeholder to the exact output aspect.
    const aspect = task.expected.width / task.expected.height;
    const current = get().items.find((i) => i.id === item.id) ?? item;
    const h = Math.round(current.w / aspect);
    if (Math.abs(h - current.h) > 1) patchEverywhere(item.id, { h, y: Math.round(current.y + (current.h - h) / 2) });
    applyTask(task);
  } catch (err) {
    patchEverywhere(item.id, { error: (err as Error).message });
    toast((err as Error).message, 'error');
  }
}

interface LaunchOptions {
  request: TaskRequest;
  kind: MediaKind;
  count?: number;
  /** Placeholder size in board units. */
  size: { w: number; h: number };
  /** Board items used as inputs, in request order (drawn as links). */
  inputs?: CanvasItem[];
  /** Place results next to this item; defaults to the first input. */
  near?: CanvasItem;
}

export async function launch({ request, kind, count = 1, size, inputs = [], near }: LaunchOptions) {
  const { items, viewport, screen, pendingOutput } = get();
  const sizes = Array.from({ length: count }, () => size);
  const rowW = size.w * count + GAP * (count - 1);
  const center = viewportCenter(viewport, screen.w, screen.h - 160);
  const anchor = near ?? inputs[0];
  // A slot the user dragged out of one of the inputs wins over automatic placement.
  const slot = pendingOutput && inputs.some((i) => i.id === pendingOutput.from) ? pendingOutput.at : null;
  const start = slot
    ? { x: slot.x, y: slot.y - size.h / 2 }
    : anchor
      ? { x: anchor.x + anchor.w + GAP * 3, y: anchor.y + (anchor.h - size.h) / 2 }
      : { x: center.x - rowW / 2, y: center.y - size.h / 2 };
  const positions = slot ? sizes.map((_, i) => ({ x: start.x + i * (size.w + GAP), y: start.y })) : placeRow(items, start, sizes);
  if (slot) useStore.setState({ pendingOutput: null });
  const now = Date.now();
  const placeholders: CanvasItem[] = positions.map((p) => ({
    id: nanoid(10),
    kind,
    x: Math.round(p.x),
    y: Math.round(p.y),
    w: Math.round(size.w),
    h: Math.round(size.h),
    request,
    inputs: inputs.length ? inputs.map((i) => i.id) : undefined,
    createdAt: now,
  }));
  commit([...items, ...placeholders]);
  ensureVisible(boundsOf(placeholders)!);
  for (const ph of placeholders) await submit(ph, request);
}

/** Same request with a fresh seed, placed next to the item and linked to the same inputs. */
export function regenerate(item: CanvasItem) {
  if (!item.request) return;
  const { seed: _seed, ...request } = item.request;
  const { items } = get();
  const inputs = inputIds(item)
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is CanvasItem => Boolean(i));
  return launch({ request: request as TaskRequest, kind: item.kind, size: { w: item.w, h: item.h }, inputs, near: item });
}

/** Ids of the items an item was made from (handles boards saved before `inputs` existed). */
export function inputIds(item: CanvasItem): string[] {
  return item.inputs ?? (item.sourceId ? [item.sourceId] : []);
}


export function retry(item: CanvasItem) {
  if (!item.request) return;
  patchEverywhere(item.id, { error: undefined, taskId: undefined });
  void submit(item, item.request);
}

export async function cancel(item: CanvasItem) {
  if (!item.taskId) return removeItems([item.id]);
  try {
    applyTask(await api.cancelTask(item.taskId));
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

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

/** Media items in the current selection, in selection order. */
export function selectedMedia(kind?: MediaKind): CanvasItem[] {
  const { selection, items } = get();
  return selection
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is CanvasItem => Boolean(i?.asset) && (!kind || i!.kind === kind));
}

/** Imported workflows and official template presets, by id. */
export function findWorkflow(id: string): WorkflowLike | undefined {
  const { workflows, presets } = get();
  return workflows.find((w) => w.id === id) ?? presets.find((p) => p.id === id);
}

/** The imported workflow or preset the composer currently points at, if any. */
export function activeWorkflow(): WorkflowLike | undefined {
  const { composer } = get();
  const id = composer.mode === 'image' ? composer.imageModel : composer.videoModel;
  return id.startsWith('custom:') ? findWorkflow(id.slice(7)) : undefined;
}

/** Selected media the composer will use, given what the current model accepts. */
export function composerReferences(): { refs: CanvasItem[]; videos: CanvasItem[]; ignored: number; needed: number } {
  const { composer } = get();
  const images = selectedMedia('image');
  const wf = activeWorkflow();
  if (wf) {
    const imageSlots = wf.inputs.filter((i) => i.type === 'image').length;
    const videoSlots = wf.inputs.filter((i) => i.type === 'video').length;
    const videos = selectedMedia('video').slice(0, videoSlots);
    return {
      refs: images.slice(0, imageSlots),
      videos,
      ignored: Math.max(0, images.length - imageSlots),
      needed: imageSlots + videoSlots,
    };
  }
  let limit: number;
  if (composer.mode === 'image') limit = composer.imageModel === 'qwen' ? 10 : 0;
  else limit = composer.videoModel === 'minimax-ref' ? 9 : 2;
  return { refs: images.slice(0, limit), videos: [], ignored: Math.max(0, images.length - limit), needed: 0 };
}

/** Runs an imported workflow with the given board items as its image/video inputs. */
export async function runWorkflow(
  wf: WorkflowLike,
  opts: { prompt?: string; images: CanvasItem[]; videos?: CanvasItem[]; mask?: AssetInfo; aspect?: string; count?: number },
) {
  const { composer } = get();
  const first = opts.images[0]?.asset;
  const hasSize = wf.inputs.some((i) => i.type === 'width') && wf.inputs.some((i) => i.type === 'height');
  const aspect = hasSize ? (opts.aspect ?? 'auto') : 'auto';
  const widthInput = wf.inputs.find((i) => i.type === 'width');
  const heightInput = wf.inputs.find((i) => i.type === 'height');
  const defaultRatio = Number(widthInput?.default) / Number(heightInput?.default);
  const ratio =
    aspectValue(aspect) ??
    (first ? first.width / first.height : Number.isFinite(defaultRatio) && defaultRatio > 0 ? defaultRatio : wf.kind === 'video' ? 16 / 9 : 1);
  await launch({
    request: {
      op: 'custom',
      workflow: wf.id,
      prompt: opts.prompt,
      images: opts.images.map((i) => i.asset!.id),
      videos: (opts.videos ?? []).map((i) => i.asset!.id),
      mask: opts.mask?.id,
      aspect,
      params: composer.params[wf.id] ?? {},
    },
    kind: wf.kind,
    count: opts.count ?? 1,
    size: displaySize(ratio, 1, wf.kind === 'video' ? VIDEO_LONG_SIDE : IMAGE_LONG_SIDE),
    inputs: [...opts.images, ...(opts.videos ?? [])],
  });
}

/** Whether a workflow can run without the user typing a prompt (none needed, or it has a default). */
export function promptOptional(wf: WorkflowLike) {
  const p = wf.inputs.find((i) => i.type === 'prompt');
  return !p || Boolean(String(p.default ?? '').trim());
}

export async function generateFromComposer() {
  const { composer, prompt } = get();
  const text = prompt.trim();
  const wf = activeWorkflow();
  const { refs, videos } = composerReferences();
  if (wf) {
    if (wf.inputs.some((i) => i.type === 'mask')) {
      toast('这个工作流需要蒙版：选中图片后，在图片上方的「我的工具」里使用', 'info');
      return;
    }
    if (!text && !promptOptional(wf)) {
      toast('先写一句提示词吧', 'info');
      return;
    }
    const needImages = wf.inputs.filter((i) => i.type === 'image' && !i.optional);
    const needVideos = wf.inputs.filter((i) => i.type === 'video' && !i.optional);
    if (refs.length < needImages.length || videos.length < needVideos.length) {
      const parts = [
        needImages.length ? `${needImages.length} 张图片（${needImages.map((i) => i.label).join('、')}）` : '',
        needVideos.length ? `${needVideos.length} 个视频` : '',
      ].filter(Boolean);
      toast(`「${wf.name}」需要先在画布上选中 ${parts.join(' 和 ')}`, 'info');
      return;
    }
    await runWorkflow(wf, {
      prompt: text,
      images: refs,
      videos,
      aspect: composer.mode === 'image' ? composer.imageAspect : composer.videoAspect,
      count: composer.mode === 'video' ? Math.min(2, composer.count) : composer.count,
    });
    return;
  }
  if (!text) {
    toast('先写一句提示词吧', 'info');
    return;
  }
  const first = refs[0]?.asset;
  if (composer.mode === 'image') {
    const aspect = composer.imageAspect === 'auto' && !first ? '1:1' : composer.imageAspect;
    const ratio = aspectValue(aspect) ?? (first ? first.width / first.height : 1);
    await launch({
      request: {
        op: 'image.generate',
        model: composer.imageModel as ImageModel,
        prompt: text,
        aspect,
        quality: composer.imageQuality,
        images: refs.map((r) => r.asset!.id),
      },
      kind: 'image',
      count: composer.count,
      size: displaySize(ratio, 1, IMAGE_LONG_SIDE),
      inputs: refs,
    });
  } else {
    const model = composer.videoModel as VideoModel;
    if (model === 'minimax-ref' && !refs.length) {
      toast('多图参考需要先在画布上选中至少一张图片', 'info');
      return;
    }
    const aspect = composer.videoAspect === 'auto' && !first ? '16:9' : composer.videoAspect;
    const ratio = aspectValue(aspect) ?? (first ? first.width / first.height : 16 / 9);
    const durations = VIDEO_DURATIONS[model];
    const duration = durations.includes(composer.duration) ? composer.duration : durations[durations.length > 1 ? 1 : 0];
    await launch({
      request: {
        op: 'video.generate',
        model,
        prompt: text,
        aspect,
        quality: composer.videoQuality,
        duration,
        images: refs.map((r) => r.asset!.id),
      },
      kind: 'video',
      count: Math.min(2, composer.count),
      size: displaySize(ratio, 1, VIDEO_LONG_SIDE),
      inputs: refs,
    });
  }
}

/** Imported workflows and presets from the server into the store. */
export async function loadWorkflows() {
  try {
    const [workflows, presets] = await Promise.all([api.workflows(), api.presets()]);
    setWorkflows(workflows, presets);
  } catch {
    /* server offline */
  }
}

// ------------------------------------------------------------------ item utilities

export function download(item: CanvasItem) {
  if (!item.asset) return;
  const ext = item.asset.url.split('.').pop();
  const a = document.createElement('a');
  a.href = item.asset.url;
  a.download = `comfy-canva-${item.id}.${ext}`;
  a.click();
}

export function duplicate(ids: string[]) {
  const { items } = get();
  const copies = cloneItems(items.filter((i) => ids.includes(i.id) && i.asset), 24, 24);
  if (!copies.length) return;
  commit([...items, ...copies]);
  select(copies.map((c) => c.id));
}

/** Copies items with fresh ids; links between copied items point at the copies. */
export function cloneItems(source: CanvasItem[], dx: number, dy: number): CanvasItem[] {
  const ids = new Map(source.map((i) => [i.id, nanoid(10)]));
  const now = Date.now();
  return source.map((i) => {
    const inputs = inputIds(i);
    return {
      ...i,
      id: ids.get(i.id)!,
      x: Math.round(i.x + dx),
      y: Math.round(i.y + dy),
      taskId: undefined,
      sourceId: undefined,
      inputs: inputs.length ? inputs.map((id) => ids.get(id) ?? id) : undefined,
      createdAt: now,
    };
  });
}

export function reorder(ids: string[], where: 'front' | 'back') {
  updateItems((items) => {
    const moving = items.filter((i) => ids.includes(i.id));
    const rest = items.filter((i) => !ids.includes(i.id));
    return where === 'front' ? [...rest, ...moving] : [...moving, ...rest];
  });
}

/** Saves the frame currently shown by a video item as a new image next to it. */
export async function captureFrame(item: CanvasItem) {
  const video = document.querySelector<HTMLVideoElement>(`[data-item-id="${item.id}"] video`);
  if (!video || !video.videoWidth) return toast('视频还没加载好', 'info');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d')!.drawImage(video, 0, 0);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) return;
  const asset = await api.uploadAsset(blob, `frame-${Math.round(video.currentTime * 1000)}ms.png`);
  addAssets([asset], undefined, item);
  toast('已截取当前帧', 'success');
}

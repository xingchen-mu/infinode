import { nanoid } from 'nanoid';
import type { CanvasItem, MediaKind, TaskRequest } from '../../shared/types';
import { applyTask, commit, removeItems, toast, useStore } from '../store';
import { api } from '../lib/api';
import { GAP, boundsOf, placeRow, viewportCenter } from '../../shared/geometry';
import { inputIds } from '../canvas/items';
import { ensureVisible } from '../canvas/view';

const get = useStore.getState;

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
  if (!item.request || item.kind === 'text') return;
  const { seed: _seed, ...request } = item.request;
  const { items } = get();
  const inputs = inputIds(item)
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is CanvasItem => Boolean(i));
  return launch({ request: request as TaskRequest, kind: item.kind, size: { w: item.w, h: item.h }, inputs, near: item });
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

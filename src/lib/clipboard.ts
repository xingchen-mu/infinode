import type { CanvasItem } from '../../shared/types';
import { commit, select, useStore } from '../store';
import { cloneItems } from './actions';
import { boundsOf } from './geometry';

/** Written to the system clipboard on copy, so a later paste knows to use our items. */
export const CLIP_MARKER = 'infinode:items';

let copied: CanvasItem[] = [];
let pasteCount = 0;

export function copySelection(): boolean {
  const { items, selection } = useStore.getState();
  const picked = items.filter((i) => selection.includes(i.id) && (i.asset || i.kind === 'text'));
  if (!picked.length) return false;
  copied = picked.map((i) => ({ ...i }));
  pasteCount = 0;
  void navigator.clipboard?.writeText(CLIP_MARKER).catch(() => {});
  return true;
}

export function hasInternalClipboard() {
  return copied.length > 0;
}

/** Pastes copied items, centered on `at` or offset from the originals. */
export function pasteInternal(at?: { x: number; y: number }) {
  if (!copied.length) return;
  const b = boundsOf(copied)!;
  pasteCount += 1;
  const dx = at ? at.x - (b.x + b.w / 2) : 32 * pasteCount;
  const dy = at ? at.y - (b.y + b.h / 2) : 32 * pasteCount;
  const clones = cloneItems(copied, dx, dy);
  commit([...useStore.getState().items, ...clones]);
  select(clones.map((c) => c.id));
}

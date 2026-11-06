import { nanoid } from 'nanoid';
import type { CanvasItem, MediaKind } from '../../shared/types';
import { commit, select, updateItems, useStore } from '../store';
import { placeRow, viewportCenter } from '../../shared/geometry';

const get = useStore.getState;

export const IMAGE_LONG_SIDE = 512;
export const VIDEO_LONG_SIDE = 640;

/** Ids of the items an item was made from (handles boards saved before `inputs` existed). */
export function inputIds(item: CanvasItem): string[] {
  return item.inputs ?? (item.sourceId ? [item.sourceId] : []);
}
/** Media items in the current selection, in selection order. */
export function selectedMedia(kind?: MediaKind): CanvasItem[] {
  const { selection, items } = get();
  return selection
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is CanvasItem => Boolean(i?.asset) && (!kind || i!.kind === kind));
}
/** A new text note at the center of the view, open for typing. */
export function addNote() {
  const { items, viewport, screen } = get();
  const c = viewportCenter(viewport, screen.w, screen.h - 160);
  const size = { w: 380, h: 260 };
  const [pos] = placeRow(items, { x: c.x - size.w / 2, y: c.y - size.h / 2 }, [size]);
  const note: CanvasItem = { id: nanoid(10), kind: 'text', x: Math.round(pos.x), y: Math.round(pos.y), ...size, name: '', text: '', createdAt: Date.now() };
  commit([...items, note]);
  select([note.id]);
  useStore.setState({ noteEditing: note.id });
}
export function duplicate(ids: string[]) {
  const { items } = get();
  const copies = cloneItems(items.filter((i) => ids.includes(i.id) && (i.asset || i.kind === 'text')), 24, 24);
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

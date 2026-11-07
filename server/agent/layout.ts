import { GAP, type Rect, intersects } from '../../shared/geometry.ts';

type Point = { x: number; y: number };
type Box = { w: number; h: number; group?: string };

export type Side = 'right' | 'left' | 'below' | 'above';
export type Arrangement = 'row' | 'column' | 'grid' | 'groups';

/**
 * Where each box goes, as offsets from the block's top-left, in the order given. `row`: tops aligned;
 * `column`: left edges aligned; `grid`: `columns` wide (about square by default), each column as wide and
 * each row as tall as its largest box; `groups`: one column per group in order of first appearance, boxes
 * without a group in a column of their own, columns twice `gap` apart (as new image types are placed).
 */
export function arrange(boxes: Box[], layout: Arrangement, opts: { columns?: number; gap?: number } = {}): { positions: Point[]; w: number; h: number } {
  const gap = opts.gap ?? GAP;
  if (!boxes.length) return { positions: [], w: 0, h: 0 };
  let positions: Point[];
  if (layout === 'row' || layout === 'column') {
    let offset = 0;
    positions = boxes.map((b) => {
      const p = layout === 'row' ? { x: offset, y: 0 } : { x: 0, y: offset };
      offset += (layout === 'row' ? b.w : b.h) + gap;
      return p;
    });
  } else if (layout === 'grid') {
    const cols = Math.max(1, Math.min(boxes.length, Math.round(opts.columns ?? 0) || Math.ceil(Math.sqrt(boxes.length))));
    const widths = Array.from({ length: cols }, (_, c) => Math.max(...boxes.filter((_, i) => i % cols === c).map((b) => b.w)));
    const rows = Math.ceil(boxes.length / cols);
    const heights = Array.from({ length: rows }, (_, r) => Math.max(...boxes.slice(r * cols, (r + 1) * cols).map((b) => b.h)));
    const before = (sizes: number[], n: number) => sizes.slice(0, n).reduce((s, v) => s + v + gap, 0);
    positions = boxes.map((_, i) => ({ x: before(widths, i % cols), y: before(heights, Math.floor(i / cols)) }));
  } else {
    const columns = new Map<string, number[]>();
    boxes.forEach((b, i) => {
      const key = b.group?.trim() ?? '';
      columns.set(key, [...(columns.get(key) ?? []), i]);
    });
    positions = [];
    let x = 0;
    for (const idx of columns.values()) {
      let y = 0;
      for (const i of idx) {
        positions[i] = { x, y };
        y += boxes[i].h + gap;
      }
      x += Math.max(...idx.map((i) => boxes[i].w)) + gap * 2;
    }
  }
  return {
    positions,
    w: Math.max(...boxes.map((b, i) => positions[i].x + b.w)),
    h: Math.max(...boxes.map((b, i) => positions[i].y + b.h)),
  };
}

/** A block of `size` next to `anchor` on `side`: beside it top-aligned, or above/below it left-aligned. */
export function besideOf(anchor: Rect, size: { w: number; h: number }, side: Side, gap = GAP * 3): Rect {
  const { w, h } = size;
  switch (side) {
    case 'right':
      return { x: anchor.x + anchor.w + gap, y: anchor.y, w, h };
    case 'left':
      return { x: anchor.x - gap - w, y: anchor.y, w, h };
    case 'below':
      return { x: anchor.x, y: anchor.y + anchor.h + gap, w, h };
    case 'above':
      return { x: anchor.x, y: anchor.y - gap - h, w, h };
  }
}

/** `r` moved further towards `side` until it overlaps none of `taken`. */
export function clearOf(taken: Rect[], r: Rect, side: Side): Rect {
  const cur = { ...r };
  for (let tries = 0; tries < 200; tries++) {
    const hits = taken.filter((t) => intersects(cur, t, GAP / 2));
    if (!hits.length) break;
    if (side === 'right') cur.x = Math.max(...hits.map((h) => h.x + h.w)) + GAP;
    else if (side === 'left') cur.x = Math.min(...hits.map((h) => h.x)) - GAP - cur.w;
    else if (side === 'below') cur.y = Math.max(...hits.map((h) => h.y + h.h)) + GAP;
    else cur.y = Math.min(...hits.map((h) => h.y)) - GAP - cur.h;
  }
  return cur;
}

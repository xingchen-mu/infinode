import type { CanvasItem, Viewport } from './types';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const GAP = 32;

export function boundsOf(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function intersects(a: Rect, b: Rect, margin = 0): boolean {
  return a.x < b.x + b.w + margin && a.x + a.w + margin > b.x && a.y < b.y + b.h + margin && a.y + a.h + margin > b.y;
}

export function toScreen(v: Viewport, r: Rect): Rect {
  return { x: r.x * v.zoom + v.x, y: r.y * v.zoom + v.y, w: r.w * v.zoom, h: r.h * v.zoom };
}

export function toWorld(v: Viewport, sx: number, sy: number) {
  return { x: (sx - v.x) / v.zoom, y: (sy - v.y) / v.zoom };
}

/** Display size for media: long side normalised so results look consistent on the board. */
export function displaySize(width: number, height: number, longSide: number) {
  const s = longSide / Math.max(width, height);
  return { w: Math.round(width * s), h: Math.round(height * s) };
}

/**
 * First free spot for a row of rects: scans right from `start`, then wraps to new rows.
 * Returns top-left positions for each rect.
 */
export function placeRow(items: CanvasItem[], start: { x: number; y: number }, sizes: { w: number; h: number }[]) {
  const rowW = sizes.reduce((s, r) => s + r.w, 0) + GAP * (sizes.length - 1);
  const rowH = Math.max(...sizes.map((r) => r.h));
  const step = Math.max(160, Math.min(rowW, 480));
  for (let row = 0; row < 40; row++) {
    for (let col = 0; col < 12; col++) {
      const candidate = { x: start.x + col * step, y: start.y + row * (rowH + GAP), w: rowW, h: rowH };
      if (!items.some((it) => intersects(candidate, it, GAP / 2))) {
        let x = candidate.x;
        return sizes.map((r) => {
          const pos = { x, y: candidate.y };
          x += r.w + GAP;
          return pos;
        });
      }
    }
  }
  return sizes.map((_, i) => ({ x: start.x + i * 40, y: start.y + i * 40 }));
}

/** The board area on screen, grown on every side by `margin` (a fraction of the screen). */
export function visibleRect(v: Viewport, width: number, height: number, margin = 0): Rect {
  const topLeft = toWorld(v, -width * margin, -height * margin);
  return { x: topLeft.x, y: topLeft.y, w: (width * (1 + 2 * margin)) / v.zoom, h: (height * (1 + 2 * margin)) / v.zoom };
}

export function viewportCenter(v: Viewport, width: number, height: number) {
  return toWorld(v, width / 2, height / 2);
}

/** Viewport that fits `r` into the screen with padding. */
export function fitViewport(r: Rect, width: number, height: number, padding = 80, maxZoom = 1): Viewport {
  const zoom = Math.min(maxZoom, (width - padding * 2) / Math.max(1, r.w), (height - padding * 2) / Math.max(1, r.h));
  const z = Math.max(0.05, zoom);
  return { zoom: z, x: width / 2 - (r.x + r.w / 2) * z, y: height / 2 - (r.y + r.h / 2) * z };
}

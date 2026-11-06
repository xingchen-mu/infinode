import { setViewport, useStore } from '../store';
import { type Rect, boundsOf, fitViewport, toScreen } from '../../shared/geometry';

const get = useStore.getState;

/** Board width left of the agent panel, when it is open. */
function viewWidth() {
  return get().screen.w - (document.body.classList.contains('agent-open') ? 392 : 0);
}

/** Pans (and zooms out if needed) so `r` is on screen. */
export function ensureVisible(r: Rect) {
  const { viewport: v, screen } = get();
  const width = viewWidth();
  const s = toScreen(v, r);
  const margin = 60;
  const bottomUi = 220;
  if (s.x >= margin && s.y >= margin && s.x + s.w <= width - margin && s.y + s.h <= screen.h - bottomUi) return;
  const fits = s.w <= width - margin * 2 && s.h <= screen.h - margin - bottomUi;
  if (fits) {
    setViewport({ ...v, x: width / 2 - (r.x + r.w / 2) * v.zoom, y: (screen.h - bottomUi + margin) / 2 - (r.y + r.h / 2) * v.zoom });
  } else {
    const fit = fitViewport(r, width, screen.h - bottomUi + margin, 60, v.zoom);
    setViewport(fit);
  }
}

/** Pans to new items once the board change that adds them has been merged in. */
export async function revealItems(ids: string[]) {
  for (let i = 0; i < 20; i++) {
    const items = get().items.filter((it) => ids.includes(it.id));
    const bounds = boundsOf(items);
    if (bounds && items.length === ids.length) return ensureVisible(bounds);
    await new Promise((r) => setTimeout(r, 150));
  }
}

export function fitAll() {
  const { items, screen } = get();
  const width = viewWidth();
  const b = boundsOf(items);
  if (!b) return setViewport({ x: width / 2, y: screen.h / 2 - 80, zoom: 1 });
  const fit = fitViewport(b, width, screen.h - 160, 80, 1);
  setViewport(fit);
}

import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CanvasItem } from '../../shared/types';
import { addFiles, ensureVisible } from '../lib/actions';
import { GAP, type Rect, boundsOf, intersects, placeRow, toScreen, toWorld } from '../lib/geometry';
import { beginGesture, endGesture, select, setComposer, setViewport, updateItems, useStore, zoomAt } from '../store';
import { ContextMenu, type MenuState } from '../ui/ContextMenu';
import { MaskCanvas } from '../editors/MaskEditor';
import { OutpaintFrame } from '../editors/OutpaintEditor';
import { ItemToolbar } from './ItemToolbar';
import { ItemView } from './ItemView';
import { Links, slotRect } from './Links';

type Handle = 'nw' | 'ne' | 'sw' | 'se';

type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { kind: 'marquee'; x0: number; y0: number; base: string[] }
  | { kind: 'move'; wx: number; wy: number; origins: Map<string, { x: number; y: number }>; snapshot: CanvasItem[]; moved: boolean; clicked: string; modifier: boolean }
  | { kind: 'resize'; anchor: { x: number; y: number }; dir: { x: number; y: number }; start: Rect; origins: Map<string, Rect>; snapshot: CanvasItem[] }
  | { kind: 'link'; from: string; sx: number; sy: number; moved: boolean };

/** Topmost item under a board point. */
function itemAt(items: CanvasItem[], p: { x: number; y: number }) {
  return [...items].reverse().find((i) => p.x >= i.x && p.x <= i.x + i.w && p.y >= i.y && p.y <= i.y + i.h);
}

/**
 * Opens an output slot linked to `from` at `at` (or beside it), selects the source so the
 * composer uses it, and focuses the prompt.
 */
function openSlot(from: CanvasItem, at?: { x: number; y: number }) {
  const st = useStore.getState();
  // Z-Image cannot take a reference image.
  if (st.composer.mode === 'image' && st.composer.imageModel === 'zimage') setComposer({ imageModel: 'qwen' });
  select([from.id]);
  let point = at;
  if (!point) {
    const probe = slotRect(from, { x: 0, y: 0 });
    const others = st.items.filter((i) => i.id !== from.id);
    const [pos] = placeRow(others, { x: from.x + from.w + GAP * 3, y: from.y + (from.h - probe.h) / 2 }, [probe]);
    point = { x: pos.x, y: pos.y + probe.h / 2 };
  }
  useStore.setState({ pendingOutput: { from: from.id, at: point } });
  ensureVisible(boundsOf([from, slotRect(from, point)])!);
  requestAnimationFrame(() => document.getElementById('composer-input')?.focus());
}

function SelectionLayer({ marquee, showHandles }: { marquee: Rect | null; showHandles: boolean }) {
  const items = useStore((s) => s.items);
  const selection = useStore((s) => s.selection);
  const viewport = useStore((s) => s.viewport);
  const selected = items.filter((i) => selection.includes(i.id));
  const b = boundsOf(selected);
  const s = b && toScreen(viewport, b);
  const single = selected.length === 1 ? selected[0] : null;
  return (
    <div className="sel-layer">
      {selected.length > 1 &&
        selected.map((i) => {
          const r = toScreen(viewport, i);
          return <div key={i.id} className="sel-item" style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />;
        })}
      {s && (
        <div className="sel-box" style={{ left: s.x, top: s.y, width: s.w, height: s.h }}>
          {showHandles && (['nw', 'ne', 'sw', 'se'] as Handle[]).map((h) => <div key={h} className={`handle ${h}`} data-handle={h} />)}
          {single?.asset && showHandles && (
            <div className="sel-dims">
              {single.asset.width} × {single.asset.height}
            </div>
          )}
          {single?.asset && single.kind === 'image' && showHandles && (
            <div className="port" data-port={single.id} title="拖出一条线，在线的另一端生成新内容">
              <Plus />
            </div>
          )}
        </div>
      )}
      {marquee && <div className="marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
    </div>
  );
}

export function Canvas() {
  const ref = useRef<HTMLDivElement>(null);
  const items = useStore((s) => s.items);
  const viewport = useStore((s) => s.viewport);
  const tool = useStore((s) => s.tool);
  const spaceHeld = useStore((s) => s.spaceHeld);
  const editing = useStore((s) => s.editing);
  const tasks = useStore((s) => s.tasks);
  const drag = useRef<Drag | null>(null);
  const [dragKind, setDragKind] = useState<Drag['kind'] | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [linkDraft, setLinkDraft] = useState<{ from: string; x: number; y: number } | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(([e]) => useStore.setState({ screen: { w: e.contentRect.width, h: e.contentRect.height } }));
    ro.observe(el);

    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('[data-scrollable]')) return;
      e.preventDefault();
      const { viewport: v } = useStore.getState();
      const r = el.getBoundingClientRect();
      const k = e.deltaMode === 1 ? 20 : 1;
      if (e.ctrlKey || e.metaKey) {
        const d = Math.max(-50, Math.min(50, e.deltaY * k));
        zoomAt(e.clientX - r.left, e.clientY - r.top, v.zoom * Math.exp(-d * 0.008));
      } else {
        setViewport({ ...v, x: v.x - e.deltaX * k, y: v.y - e.deltaY * k });
      }
    };
    // Safari reports trackpad pinch as gesture events.
    let gestureZoom = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureZoom = useStore.getState().viewport.zoom;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      const r = el.getBoundingClientRect();
      zoomAt(g.clientX - r.left, g.clientY - r.top, gestureZoom * g.scale);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart);
    el.addEventListener('gesturechange', onGestureChange);
    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
    };
  }, []);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-ui]')) return;
    setMenu(null);
    const st = useStore.getState();
    const { sx, sy } = local(e);
    if (e.button === 1 || (e.button === 0 && (st.tool === 'hand' || st.spaceHeld))) {
      drag.current = { kind: 'pan', sx, sy, vx: st.viewport.x, vy: st.viewport.y };
    } else if (e.button === 0) {
      if (st.editing) return;
      (document.activeElement as HTMLElement | null)?.blur?.();
      const handle = target.closest('[data-handle]')?.getAttribute('data-handle') as Handle | null;
      const port = target.closest('[data-port]')?.getAttribute('data-port');
      const selected = st.items.filter((i) => st.selection.includes(i.id));
      const w = toWorld(st.viewport, sx, sy);
      if (port) {
        drag.current = { kind: 'link', from: port, sx, sy, moved: false };
      } else if (handle && selected.length) {
        const b = boundsOf(selected)!;
        const dir = { x: handle.includes('e') ? 1 : -1, y: handle.includes('s') ? 1 : -1 };
        drag.current = {
          kind: 'resize',
          dir,
          anchor: { x: dir.x > 0 ? b.x : b.x + b.w, y: dir.y > 0 ? b.y : b.y + b.h },
          start: b,
          origins: new Map(selected.map((i) => [i.id, { x: i.x, y: i.y, w: i.w, h: i.h }])),
          snapshot: beginGesture(),
        };
      } else {
        const itemId = target.closest('[data-item-id]')?.getAttribute('data-item-id');
        const modifier = e.shiftKey || e.metaKey || e.ctrlKey;
        if (itemId) {
          if (modifier) {
            select([itemId], 'toggle');
            if (!useStore.getState().selection.includes(itemId)) return;
          } else if (!st.selection.includes(itemId)) {
            select([itemId]);
          }
          const now = useStore.getState();
          drag.current = {
            kind: 'move',
            wx: w.x,
            wy: w.y,
            origins: new Map(now.items.filter((i) => now.selection.includes(i.id)).map((i) => [i.id, { x: i.x, y: i.y }])),
            snapshot: beginGesture(),
            moved: false,
            clicked: itemId,
            modifier,
          };
        } else {
          if (!modifier) select([]);
          drag.current = { kind: 'marquee', x0: w.x, y0: w.y, base: modifier ? st.selection : [] };
        }
      }
    } else {
      return;
    }
    ref.current!.setPointerCapture(e.pointerId);
    setDragKind(drag.current?.kind ?? null);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const st = useStore.getState();
    const { sx, sy } = local(e);
    if (!d) {
      // Hovering an item lifts its links above the other items.
      const over = (e.target as HTMLElement).closest('[data-ui]') ? undefined : itemAt(st.items, toWorld(st.viewport, sx, sy));
      const id = over?.id ?? null;
      if (id !== hovered) setHovered(id);
      return;
    }
    if (d.kind === 'pan') {
      setViewport({ ...st.viewport, x: d.vx + sx - d.sx, y: d.vy + sy - d.sy });
      return;
    }
    const w = toWorld(st.viewport, sx, sy);
    if (d.kind === 'link') {
      if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) < 4) return;
      d.moved = true;
      setLinkDraft({ from: d.from, x: w.x, y: w.y });
      return;
    }
    if (d.kind === 'move') {
      const dx = w.x - d.wx;
      const dy = w.y - d.wy;
      if (!d.moved && Math.hypot(dx, dy) * st.viewport.zoom < 3) return;
      d.moved = true;
      updateItems(
        (list) => list.map((i) => {
          const o = d.origins.get(i.id);
          return o ? { ...i, x: Math.round(o.x + dx), y: Math.round(o.y + dy) } : i;
        }),
        false,
      );
    } else if (d.kind === 'resize') {
      const fx = ((w.x - d.anchor.x) * d.dir.x) / d.start.w;
      const fy = ((w.y - d.anchor.y) * d.dir.y) / d.start.h;
      const s = Math.max(16 / Math.min(d.start.w, d.start.h), Math.max(fx, fy));
      updateItems(
        (list) => list.map((i) => {
          const o = d.origins.get(i.id);
          if (!o) return i;
          return {
            ...i,
            x: Math.round(d.anchor.x + (o.x - d.anchor.x) * s),
            y: Math.round(d.anchor.y + (o.y - d.anchor.y) * s),
            w: Math.round(o.w * s),
            h: Math.round(o.h * s),
          };
        }),
        false,
      );
    } else if (d.kind === 'marquee') {
      const r = { x: Math.min(d.x0, w.x), y: Math.min(d.y0, w.y), w: Math.abs(w.x - d.x0), h: Math.abs(w.y - d.y0) };
      setMarquee(toScreen(st.viewport, r));
      const hits = st.items.filter((i) => intersects(r, i)).map((i) => i.id);
      select([...new Set([...d.base, ...hits])]);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    setDragKind(null);
    setMarquee(null);
    if (ref.current?.hasPointerCapture(e.pointerId)) ref.current.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.kind === 'move') {
      if (d.moved) endGesture(d.snapshot);
      else if (!d.modifier) select([d.clicked]);
    } else if (d.kind === 'resize') {
      endGesture(d.snapshot);
    } else if (d.kind === 'link') {
      setLinkDraft(null);
      const st = useStore.getState();
      const from = st.items.find((i) => i.id === d.from);
      if (!from) return;
      if (!d.moved) return openSlot(from); // plain click on the port: slot beside the image
      const { sx, sy } = local(e);
      const p = toWorld(st.viewport, sx, sy);
      if (itemAt(st.items, p)) return; // dropped onto an item: nothing to connect to
      // Put the slot's edge that faces the source under the pointer.
      const { w, h } = slotRect(from, p);
      const dx = (p.x - (from.x + from.w / 2)) / (from.w / 2 + w / 2);
      const dy = (p.y - (from.y + from.h / 2)) / (from.h / 2 + h / 2);
      let left: number;
      let top: number;
      if (Math.abs(dx) >= Math.abs(dy)) {
        left = dx >= 0 ? p.x : p.x - w;
        top = p.y - h / 2;
      } else {
        left = p.x - w / 2;
        top = dy >= 0 ? p.y : p.y - h;
      }
      openSlot(from, { x: left, y: top + h / 2 });
    }
  };

  // Pointer capture retargets click/dblclick to the board itself, so hit-test by position.
  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-ui]')) return;
    const st = useStore.getState();
    if (st.editing) return;
    const { sx, sy } = local(e);
    const p = toWorld(st.viewport, sx, sy);
    const item = itemAt(st.items, p);
    if (item?.asset) useStore.setState({ lightboxId: item.id });
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if ((e.target as HTMLElement).closest('[data-ui]')) return;
    const id = (e.target as HTMLElement).closest('[data-item-id]')?.getAttribute('data-item-id') ?? undefined;
    if (id && !useStore.getState().selection.includes(id)) select([id]);
    const { sx, sy } = local(e);
    setMenu({ x: sx, y: sy, itemId: id, world: toWorld(useStore.getState().viewport, sx, sy) });
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    const { sx, sy } = local(e);
    void addFiles(files, toWorld(useStore.getState().viewport, sx, sy));
  };

  let step = 24 * viewport.zoom;
  while (step < 12) step *= 2;
  while (step > 48) step /= 2;
  const panning = dragKind === 'pan';
  const cursor = panning ? 'grabbing' : tool === 'hand' || spaceHeld ? 'grab' : 'default';
  const showOverlays = !editing && dragKind !== 'move' && dragKind !== 'resize' && dragKind !== 'pan' && dragKind !== 'link';

  return (
    <div
      ref={ref}
      className={`canvas ${dropping ? 'dropping' : ''} ${editing ? 'is-editing' : ''}`}
      style={{ cursor, backgroundSize: `${step}px ${step}px`, backgroundPosition: `${viewport.x}px ${viewport.y}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropping(false);
      }}
      onDrop={onDrop}
    >
      <div
        className="world"
        style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`, ['--zoom' as string]: viewport.zoom }}
      >
        <Links draft={linkDraft} layer="below" hovered={hovered} />
        {items.map((it) => (
          <ItemView key={it.id} item={it} task={it.taskId ? tasks[it.taskId] : undefined} />
        ))}
        <Links draft={linkDraft} layer="above" hovered={hovered} />
        {editing && editing.kind !== 'outpaint' && <MaskCanvas key={editing.itemId} />}
      </div>
      {!editing && <SelectionLayer marquee={marquee} showHandles={dragKind !== 'move'} />}
      {editing?.kind === 'outpaint' && <OutpaintFrame key={editing.itemId} />}
      {showOverlays && !marquee && <ItemToolbar />}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {items.length === 0 && !editing && (
        <div className="empty-hint">
          <div className="empty-title">从一句话开始创作</div>
          <div className="empty-sub">在下方输入提示词生成图片或视频，或把图片拖进画布</div>
        </div>
      )}
    </div>
  );
}

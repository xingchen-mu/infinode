import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { CanvasItem } from '../../shared/types';
import { outpaint } from '../generation/edits';
import { type Rect, toScreen, toWorld } from '../../shared/geometry';
import { aspectValue } from '../generation/models';
import { useStore } from '../store';
import { t } from '../i18n';

interface OutpaintState {
  frame: Rect | null;
  preset: string;
  prompt: string;
}

const useOutpaint = create<OutpaintState>(() => ({ frame: null, preset: '1.5x', prompt: '' }));

const PRESETS = ['1.5x', '2x', '1:1', '4:3', '3:4', '16:9', '9:16'];

/** Smallest centered frame with the preset's shape that contains the item (and grows it). */
function presetFrame(item: CanvasItem, preset: string): Rect {
  const cx = item.x + item.w / 2;
  const cy = item.y + item.h / 2;
  let w: number;
  let h: number;
  if (preset.endsWith('x')) {
    const k = Number(preset.slice(0, -1));
    w = item.w * k;
    h = item.h * k;
  } else {
    const r = aspectValue(preset)!;
    w = Math.max(item.w, item.h * r);
    h = w / r;
    if (h < item.h) {
      h = item.h;
      w = h * r;
    }
    if (w * h < item.w * item.h * 1.15) {
      w *= 1.4;
      h *= 1.4;
    }
  }
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export function OutpaintFrame() {
  const editing = useStore((s) => s.editing)!;
  const item = useStore((s) => s.items.find((i) => i.id === editing.itemId));
  const viewport = useStore((s) => s.viewport);
  const frame = useOutpaint((s) => s.frame);
  const drag = useRef<{ edge: Edge; start: Rect; wx: number; wy: number } | null>(null);

  useEffect(() => {
    if (item) useOutpaint.setState({ frame: presetFrame(item, '1.5x'), preset: '1.5x', prompt: '' });
    return () => useOutpaint.setState({ frame: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!item?.asset || !frame) return null;
  const f = toScreen(viewport, frame);
  const it = toScreen(viewport, item);
  const k = item.asset.width / item.w;

  const onDown = (edge: Edge) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const w = toWorld(viewport, e.clientX, e.clientY);
    drag.current = { edge, start: frame, wx: w.x, wy: w.y };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const w = toWorld(useStore.getState().viewport, e.clientX, e.clientY);
    const dx = w.x - d.wx;
    const dy = w.y - d.wy;
    let { x, y, w: fw, h: fh } = d.start;
    let right = x + fw;
    let bottom = y + fh;
    if (d.edge.includes('w')) x = Math.min(item.x, x + dx);
    if (d.edge.includes('e')) right = Math.max(item.x + item.w, right + dx);
    if (d.edge.includes('n')) y = Math.min(item.y, y + dy);
    if (d.edge.includes('s')) bottom = Math.max(item.y + item.h, bottom + dy);
    // Keep the result under ~4x the original size on each axis.
    x = Math.max(x, item.x - item.w * 1.5);
    right = Math.min(right, item.x + item.w * 2.5);
    y = Math.max(y, item.y - item.h * 1.5);
    bottom = Math.min(bottom, item.y + item.h * 2.5);
    useOutpaint.setState({ frame: { x, y, w: right - x, h: bottom - y }, preset: '' });
  };
  const onUp = () => (drag.current = null);

  const edges: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  const shades = [
    { left: f.x, top: f.y, width: f.w, height: it.y - f.y },
    { left: f.x, top: it.y + it.h, width: f.w, height: f.y + f.h - (it.y + it.h) },
    { left: f.x, top: it.y, width: it.x - f.x, height: it.h },
    { left: it.x + it.w, top: it.y, width: f.x + f.w - (it.x + it.w), height: it.h },
  ].filter((r) => r.width > 0.5 && r.height > 0.5);
  return (
    <div className="outpaint-layer" data-ui>
      <style>{`.item[data-item-id="${item.id}"]{opacity:1!important}`}</style>
      {shades.map((r, i) => (
        <div key={i} className="op-shade" style={r} />
      ))}
      <div className="op-frame" style={{ left: f.x, top: f.y, width: f.w, height: f.h }}>
        {edges.map((edge) => (
          <div key={edge} className={`op-handle ${edge}`} onPointerDown={onDown(edge)} onPointerMove={onMove} onPointerUp={onUp} />
        ))}
        <div className="op-size">
          {Math.round(frame.w * k)} × {Math.round(frame.h * k)}
        </div>
      </div>
    </div>
  );
}

export function OutpaintPanel() {
  const editing = useStore((s) => s.editing)!;
  const item = useStore((s) => s.items.find((i) => i.id === editing.itemId));
  const { frame, preset, prompt } = useOutpaint();
  const close = () => useStore.setState({ editing: null });
  const grown = item && frame && (frame.w > item.w + 1 || frame.h > item.h + 1);

  const submit = () => {
    if (!item || !frame || !grown) return;
    close();
    void outpaint(item, frame, prompt.trim());
  };

  return (
    <div className="panel edit-panel" data-ui>
      <div className="edit-head">
        <div className="edit-title">{t('扩图')}</div>
        <div className="edit-hint">{t('拖动虚线框的边或角设置扩展范围，也可以选一个比例')}</div>
      </div>
      <div className="edit-tools">
        <div className="chips">
          {PRESETS.map((p) => (
            <button
              key={p}
              className={`chip ${preset === p ? 'on' : ''}`}
              onClick={() => item && useOutpaint.setState({ frame: presetFrame(item, p), preset: p })}
            >
              {p === '1.5x' ? t('等比 1.5 倍') : p === '2x' ? t('等比 2 倍') : p}
            </button>
          ))}
        </div>
      </div>
      <textarea
        className="edit-prompt"
        rows={2}
        placeholder={t('描述扩展区域的内容（可选），例如：远处是海边的落日')}
        value={prompt}
        onChange={(e) => useOutpaint.setState({ prompt: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="edit-actions">
        <button className="btn ghost" onClick={close}>
          {t('取消')}
        </button>
        <button className="btn primary" onClick={submit} disabled={!grown}>
          {t('扩图')}
        </button>
      </div>
    </div>
  );
}

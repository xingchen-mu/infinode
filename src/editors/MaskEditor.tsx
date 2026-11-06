import { Brush, Eraser, Loader2, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { maskedEdit } from '../generation/edits';
import { runWorkflow } from '../workflows/actions';
import { api } from '../lib/api';
import { toast, useStore } from '../store';
import { t } from '../i18n';

interface MaskState {
  size: number;
  erasing: boolean;
  canvas: HTMLCanvasElement | null;
  history: ImageData[];
  hasStrokes: boolean;
  prompt: string;
}

export const useMask = create<MaskState>(() => ({
  size: 48,
  erasing: false,
  canvas: null,
  history: [],
  hasStrokes: false,
  prompt: '',
}));

const STROKE = '#b8f36b';

function canvasHasPaint(c: HTMLCanvasElement) {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 16) if (d[i] > 0) return true;
  return false;
}

export function undoStroke() {
  const { canvas, history } = useMask.getState();
  if (!canvas || !history.length) return;
  canvas.getContext('2d')!.putImageData(history[history.length - 1], 0, 0);
  useMask.setState({ history: history.slice(0, -1), hasStrokes: canvasHasPaint(canvas) });
}

export function clearMask() {
  const { canvas, history } = useMask.getState();
  if (!canvas) return;
  const ctx = canvas.getContext('2d')!;
  useMask.setState({ history: [...history.slice(-19), ctx.getImageData(0, 0, canvas.width, canvas.height)] });
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  useMask.setState({ hasStrokes: false });
}

export function resizeBrush(delta: number) {
  useMask.setState((s) => ({ size: Math.min(200, Math.max(6, Math.round(s.size * (delta > 0 ? 1.2 : 1 / 1.2)))) }));
}

/** White-on-black PNG at the image's own resolution. */
function exportMask(canvas: HTMLCanvasElement, width: number, height: number): Promise<Blob> {
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(canvas, 0, 0, width, height);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  return new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error(t('导出蒙版失败')))), 'image/png'));
}

/** Paint layer over the edited item, in board space. */
export function MaskCanvas() {
  const editing = useStore((s) => s.editing)!;
  const item = useStore((s) => s.items.find((i) => i.id === editing.itemId));
  const zoom = useStore((s) => s.viewport.zoom);
  const size = useMask((s) => s.size);
  const ref = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  const asset = item?.asset;
  const scale = asset ? Math.min(1, 1536 / Math.max(asset.width, asset.height)) : 1;
  const cw = asset ? Math.round(asset.width * scale) : 1;
  const ch = asset ? Math.round(asset.height * scale) : 1;

  useEffect(() => {
    useMask.setState({ canvas: ref.current, history: [], hasStrokes: false, erasing: false });
    return () => useMask.setState({ canvas: null, history: [], hasStrokes: false });
  }, []);

  if (!item || !asset) return null;

  const toCanvas = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * cw, y: ((e.clientY - r.top) / r.height) * ch, radius: (useMask.getState().size / 2 / r.width) * cw };
  };

  const stroke = (from: { x: number; y: number }, to: { x: number; y: number }, radius: number) => {
    const ctx = ref.current!.getContext('2d')!;
    ctx.globalCompositeOperation = useMask.getState().erasing ? 'destination-out' : 'source-over';
    ctx.strokeStyle = STROKE;
    ctx.fillStyle = STROKE;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = radius * 2;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const st = useStore.getState();
    if (e.button !== 0 || st.spaceHeld || st.tool === 'hand') return; // let the board pan
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const c = ref.current!;
    const { history } = useMask.getState();
    useMask.setState({ history: [...history.slice(-19), c.getContext('2d')!.getImageData(0, 0, cw, ch)] });
    const p = toCanvas(e);
    last.current = p;
    stroke(p, { x: p.x + 0.01, y: p.y }, p.radius);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = ref.current!.getBoundingClientRect();
    setCursor({ x: ((e.clientX - r.left) / r.width) * item.w, y: ((e.clientY - r.top) / r.height) * item.h });
    if (!last.current) return;
    const p = toCanvas(e);
    stroke(last.current, p, p.radius);
    last.current = p;
  };

  const onPointerUp = () => {
    if (!last.current) return;
    last.current = null;
    useMask.setState({ hasStrokes: canvasHasPaint(ref.current!) });
  };

  const d = size / zoom;
  return (
    <>
      <style>{`.item[data-item-id="${item.id}"]{opacity:1!important}`}</style>
      <canvas
        ref={ref}
        width={cw}
        height={ch}
        className="mask-canvas"
        style={{ transform: `translate(${item.x}px, ${item.y}px)`, width: item.w, height: item.h }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setCursor(null)}
      />
      {cursor && (
        <div
          className="brush-cursor"
          style={{ transform: `translate(${item.x + cursor.x - d / 2}px, ${item.y + cursor.y - d / 2}px)`, width: d, height: d, borderWidth: 1.5 / zoom }}
        />
      )}
    </>
  );
}

export function MaskPanel() {
  const editing = useStore((s) => s.editing)!;
  const item = useStore((s) => s.items.find((i) => i.id === editing.itemId));
  const { size, erasing, hasStrokes, history, prompt } = useMask();
  const workflow = useStore((s) =>
    editing.workflowId ? (s.workflows.find((w) => w.id === editing.workflowId) ?? s.presets.find((p) => p.id === editing.workflowId)) : undefined,
  );
  const [busy, setBusy] = useState(false);
  const custom = editing.kind === 'custom';
  const wantsPrompt = custom ? Boolean(workflow?.inputs.some((i) => i.type === 'prompt')) : editing.kind === 'inpaint';
  const inpaint = wantsPrompt;
  const close = () => {
    useStore.setState({ editing: null });
    useMask.setState({ prompt: '' });
  };

  const submit = async () => {
    const { canvas } = useMask.getState();
    if (!canvas || !item?.asset || busy) return;
    if (!hasStrokes) return toast(t('先在图片上涂抹要修改的区域'), 'info');
    if (editing.kind === 'inpaint' && !prompt.trim()) return toast(t('描述一下涂抹区域要画什么'), 'info');
    setBusy(true);
    try {
      const blob = await exportMask(canvas, item.asset.width, item.asset.height);
      close();
      if (custom) {
        if (!workflow) throw new Error(t('这个工作流已被删除'));
        const mask = await api.uploadAsset(blob, 'mask.png');
        await runWorkflow(workflow, { prompt: prompt.trim(), images: [item], mask });
        return;
      }
      await maskedEdit(item, editing.kind as 'inpaint' | 'erase', blob, prompt.trim());
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel edit-panel" data-ui>
      <div className="edit-head">
        <div className="edit-title">{custom ? t(workflow?.name ?? '工作流') : editing.kind === 'inpaint' ? t('局部重绘') : t('消除')}</div>
        <div className="edit-hint">
          {custom ? t('涂抹要处理的区域') : editing.kind === 'inpaint' ? t('涂抹要重画的区域，再描述想画的内容') : t('涂抹想去掉的物体，会用周围背景自然补全')}
        </div>
      </div>
      <div className="edit-tools">
        <div className="seg">
          <button className={!erasing ? 'on' : ''} onClick={() => useMask.setState({ erasing: false })} title={t('画笔 (B)')}>
            <Brush /> {t('画笔')}
          </button>
          <button className={erasing ? 'on' : ''} onClick={() => useMask.setState({ erasing: true })} title={t('橡皮 (E)')}>
            <Eraser /> {t('橡皮')}
          </button>
        </div>
        <label className="slider" title={t('笔刷大小 ( [ / ] )')}>
          <span>{t('大小')}</span>
          <input type="range" min={6} max={200} value={size} onChange={(e) => useMask.setState({ size: Number(e.target.value) })} />
          <span className="slider-val">{size}</span>
        </label>
        <button className="icon-btn" onClick={undoStroke} disabled={!history.length} title={t('撤销一笔 (⌘Z)')}>
          <Undo2 />
        </button>
        <button className="icon-btn" onClick={clearMask} disabled={!hasStrokes} title={t('清空')}>
          <Trash2 />
        </button>
      </div>
      {inpaint && (
        <textarea
          className="edit-prompt"
          rows={2}
          autoFocus
          placeholder={t('例如：一只戴墨镜的柯基')}
          value={prompt}
          onChange={(e) => useMask.setState({ prompt: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
      )}
      <div className="edit-actions">
        <button className="btn ghost" onClick={close}>
          {t('取消')}
        </button>
        <button className="btn primary" onClick={() => void submit()} disabled={busy || !hasStrokes || (editing.kind === 'inpaint' && !prompt.trim())}>
          {busy ? <Loader2 className="spin" /> : null}
          {custom ? t('生成') : editing.kind === 'inpaint' ? t('重绘') : t('消除')}
        </button>
      </div>
    </div>
  );
}

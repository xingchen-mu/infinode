import type { CanvasItem } from '../../shared/types';
import { IMAGE_LONG_SIDE, VIDEO_LONG_SIDE, inputIds } from '../lib/actions';
import { type Rect, displaySize } from '../lib/geometry';
import { aspectValue } from '../lib/models';
import { useStore } from '../store';
import { t } from '../i18n';

interface Pt {
  x: number;
  y: number;
}

/** Bezier from the side of `a` that faces `b` to the side of `b` that faces `a`. */
export function linkPath(a: Rect, b: Rect) {
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + b.h / 2;
  const right = bcx >= acx;
  const down = bcy >= acy;
  const gapX = right ? b.x - (a.x + a.w) : a.x - (b.x + b.w);
  const gapY = down ? b.y - (a.y + a.h) : a.y - (b.y + b.h);
  let p0: Pt;
  let p3: Pt;
  let c1: Pt;
  let c2: Pt;
  if (gapX >= gapY) {
    p0 = { x: right ? a.x + a.w : a.x, y: acy };
    p3 = { x: right ? b.x : b.x + b.w, y: bcy };
    const k = Math.max(40, Math.abs(p3.x - p0.x) * 0.5) * (right ? 1 : -1);
    c1 = { x: p0.x + k, y: p0.y };
    c2 = { x: p3.x - k, y: p3.y };
  } else {
    p0 = { x: acx, y: down ? a.y + a.h : a.y };
    p3 = { x: bcx, y: down ? b.y : b.y + b.h };
    const k = Math.max(40, Math.abs(p3.y - p0.y) * 0.5) * (down ? 1 : -1);
    c1 = { x: p0.x, y: p0.y + k };
    c2 = { x: p3.x, y: p3.y - k };
  }
  return {
    d: `M${p0.x},${p0.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p3.x},${p3.y}`,
    p0,
    p3,
    mid: { x: (p0.x + 3 * c1.x + 3 * c2.x + p3.x) / 8, y: (p0.y + 3 * c1.y + 3 * c2.y + p3.y) / 8 },
  };
}

/** What an input was used for, shown on its link. */
function linkLabel(out: CanvasItem, input: CanvasItem, index: number, total: number): string {
  const r = out.request;
  if (!r) return input.kind === 'video' ? t('截帧') : '';
  switch (r.op) {
    case 'image.generate':
      return total > 1 ? t('图{n}', { n: index + 1 }) : t('参考');
    case 'video.generate':
      if (r.model === 'minimax-ref') return t('参考{n}', { n: index + 1 });
      return index === 0 ? t('首帧') : t('尾帧');
    case 'image.inpaint':
      return t('局部重绘');
    case 'image.erase':
      return t('消除');
    case 'image.outpaint':
      return t('扩图');
    case 'image.removeBg':
      return t('抠图');
    case 'image.upscale':
      return t('超清 {scale}×', { scale: r.scale });
    case 'custom': {
      const { workflows, presets } = useStore.getState();
      const wf = workflows.find((w) => w.id === r.workflow) ?? presets.find((p) => p.id === r.workflow);
      const slots = wf?.inputs.filter((i) => i.type === 'image' || i.type === 'video') ?? [];
      return t(slots[index]?.label ?? wf?.name ?? '工作流');
    }
  }
}

/** Size of the result the composer would produce from `source`, for the dashed output slot. */
function slotSize(source: CanvasItem) {
  const { composer } = useStore.getState();
  const srcRatio = source.asset ? source.asset.width / source.asset.height : source.w / source.h;
  if (composer.mode === 'image') {
    const ratio = aspectValue(composer.imageAspect) ?? srcRatio;
    return displaySize(ratio, 1, IMAGE_LONG_SIDE);
  }
  const ratio = aspectValue(composer.videoAspect) ?? srcRatio;
  return displaySize(ratio, 1, VIDEO_LONG_SIDE);
}

export function slotRect(source: CanvasItem, at: Pt): Rect {
  const s = slotSize(source);
  return { x: at.x, y: at.y - s.h / 2, ...s };
}

interface LinkView {
  key: string;
  d: string;
  p0: Pt;
  p3: Pt;
  mid: Pt;
  label: string;
  state: 'idle' | 'active' | 'pending' | 'failed' | 'draft';
}

/**
 * Lines between inputs and the results made from them, in board space (inside the transformed world).
 * Rendered twice: quiet links under the items, and the ones that matter right now (selected,
 * generating, being dragged) over them so they never hide behind an unrelated image.
 */
export function Links({
  draft,
  layer,
  hovered,
}: {
  draft: { from: string; x: number; y: number } | null;
  layer: 'below' | 'above';
  hovered: string | null;
}) {
  const items = useStore((s) => s.items);
  const selection = useStore((s) => s.selection);
  const zoom = useStore((s) => s.viewport.zoom);
  const showLinks = useStore((s) => s.showLinks);
  const pendingOutput = useStore((s) => s.pendingOutput);
  useStore((s) => s.composer); // slot size follows the composer settings

  const byId = new Map(items.map((i) => [i.id, i]));
  const selected = new Set(selection);
  const views: LinkView[] = [];

  if (showLinks) {
    for (const out of items) {
      const ids = inputIds(out);
      ids.forEach((id, index) => {
        const input = byId.get(id);
        if (!input || input.id === out.id) return;
        const p = linkPath(input, out);
        const focused = selected.has(out.id) || selected.has(id) || hovered === out.id || hovered === id;
        const state = out.error ? 'failed' : !out.asset ? 'pending' : focused ? 'active' : 'idle';
        views.push({ key: `${id}>${out.id}>${index}`, ...p, label: linkLabel(out, input, index, ids.length), state });
      });
    }
  }

  let slot: Rect | null = null;
  const slotSource = pendingOutput && byId.get(pendingOutput.from);
  if (pendingOutput && slotSource) {
    slot = slotRect(slotSource, pendingOutput.at);
    views.push({ key: 'slot', ...linkPath(slotSource, slot), label: '', state: 'draft' });
  }
  const draftSource = draft && byId.get(draft.from);
  if (draft && draftSource) {
    views.push({ key: 'draft', ...linkPath(draftSource, { x: draft.x, y: draft.y, w: 0, h: 0 }), label: '', state: 'draft' });
  }

  const shown = views.filter((v) => (layer === 'below' ? v.state === 'idle' || v.state === 'failed' : v.state !== 'idle' && v.state !== 'failed'));
  if (!shown.length) return null;
  const sw = 1.6 / zoom;
  const r = 3.6 / zoom;
  const dash = `${6 / zoom} ${5 / zoom}`;
  return (
    <>
      <svg className="links" style={{ ['--dash-period' as string]: `${11 / zoom}px` }}>
        {shown.map((v) => (
          <g key={v.key} className={`link ${v.state}`}>
            <path d={v.d} strokeWidth={sw} strokeDasharray={v.state === 'pending' || v.state === 'draft' ? dash : undefined} />
            <circle cx={v.p0.x} cy={v.p0.y} r={r} strokeWidth={sw} />
            {v.key !== 'draft' && <circle cx={v.p3.x} cy={v.p3.y} r={r} strokeWidth={sw} />}
          </g>
        ))}
      </svg>
      {shown
        .filter((v) => v.label && (v.state === 'active' || v.state === 'pending'))
        .map((v) => (
          <div
            key={`label-${v.key}`}
            className={`link-label ${v.state}`}
            style={{ transform: `translate(${v.mid.x}px, ${v.mid.y}px) translate(-50%, -50%) scale(${1 / zoom})` }}
          >
            {v.label}
          </div>
        ))}
      {slot && layer === 'above' && (
        <div className="slot" style={{ transform: `translate(${slot.x}px, ${slot.y}px)`, width: slot.w, height: slot.h }}>
          <div className="slot-text">
            {t('在下方输入提示词')}
            <br />
            {t('结果会生成在这里')}
            <small>{t('Esc 取消')}</small>
          </div>
        </div>
      )}
    </>
  );
}

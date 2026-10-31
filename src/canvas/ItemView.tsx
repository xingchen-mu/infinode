import { AlertTriangle, Loader2, RotateCcw, Trash2, Volume2, X } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import type { CanvasItem, Task } from '../../shared/types';
import { cancel, retry } from '../lib/actions';
import { api } from '../lib/api';
import { patchItem, removeItems } from '../store';

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return <span className="ph-elapsed">{s >= 60 ? `${Math.floor(s / 60)}分${s % 60}秒` : `${s}秒`}</span>;
}

function Placeholder({ item, task }: { item: CanvasItem; task?: Task }) {
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  if (item.error) {
    return (
      <div className="ph ph-error">
        <div className="ph-inner">
          <AlertTriangle className="ph-icon" />
          <div className="ph-text" title={item.error}>
            {item.error}
          </div>
          <div className="ph-actions">
            {item.request && (
              <button className="ph-btn" onPointerDown={stop} onClick={() => retry(item)}>
                <RotateCcw /> 重试
              </button>
            )}
            <button className="ph-btn" onPointerDown={stop} onClick={() => removeItems([item.id])}>
              <Trash2 /> 删除
            </button>
          </div>
        </div>
      </div>
    );
  }
  const running = task?.status === 'running';
  const label = task?.stage ?? '提交中…';
  const progress = task?.progress ?? 0;
  return (
    <div className={`ph ${running ? 'ph-running' : ''}`}>
      <div className="ph-inner">
        <Loader2 className="ph-icon spin" />
        <div className="ph-text">{label}</div>
        {task && (
          <div className="ph-meta">
            {running && task.startedAt ? <Elapsed since={task.startedAt} /> : null}
          </div>
        )}
      </div>
      {task && (
        <button className="ph-cancel" title="取消" onPointerDown={stop} onClick={() => void cancel(item)}>
          <X />
        </button>
      )}
      <div className="ph-progress">
        <div style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
    </div>
  );
}

function VideoView({ item }: { item: CanvasItem }) {
  const ref = useRef<HTMLVideoElement>(null);
  const asset = item.asset!;
  const [duration, setDuration] = useState<number | null>(null);
  return (
    <>
      <video
        ref={ref}
        src={asset.url}
        muted
        loop
        playsInline
        preload="metadata"
        onMouseEnter={() => void ref.current?.play().catch(() => {})}
        onMouseLeave={() => ref.current?.pause()}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          setDuration(v.duration);
          if (v.videoWidth && v.videoHeight && (v.videoWidth !== asset.width || v.videoHeight !== asset.height)) {
            const fixed = { ...asset, width: v.videoWidth, height: v.videoHeight };
            patchItem(item.id, { asset: fixed, h: Math.round(item.w * (v.videoHeight / v.videoWidth)) });
            void api.setAssetSize(asset.id, v.videoWidth, v.videoHeight).catch(() => {});
          }
        }}
      />
      <div className="video-badge">
        {item.request?.op === 'video.generate' && <Volume2 />}
        {duration ? `${duration.toFixed(1)}s` : '视频'}
      </div>
    </>
  );
}

export const ItemView = memo(function ItemView({ item, task }: { item: CanvasItem; task?: Task }) {
  return (
    <div
      className={`item ${item.asset ? '' : 'item-pending'}`}
      data-item-id={item.id}
      style={{ transform: `translate(${item.x}px, ${item.y}px)`, width: item.w, height: item.h }}
    >
      {item.asset ? (
        item.kind === 'image' ? (
          <img src={item.asset.url} alt={item.name ?? ''} draggable={false} decoding="async" />
        ) : (
          <VideoView item={item} />
        )
      ) : (
        <Placeholder item={item} task={task} />
      )}
    </div>
  );
});

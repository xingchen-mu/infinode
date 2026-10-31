import { Download, X } from 'lucide-react';
import { useEffect } from 'react';
import type { TaskRequest } from '../../shared/types';
import { download } from '../lib/actions';
import { IMAGE_MODELS, VIDEO_MODELS } from '../lib/models';
import { useStore } from '../store';

function describe(r: TaskRequest): [string, string][] {
  const rows: [string, string][] = [];
  switch (r.op) {
    case 'image.generate':
      rows.push(['操作', r.images?.length ? '参考图生成' : '文生图'], ['模型', IMAGE_MODELS.find((m) => m.id === r.model)?.name ?? r.model]);
      break;
    case 'video.generate':
      rows.push(['操作', '生成视频'], ['模型', VIDEO_MODELS.find((m) => m.id === r.model)?.name ?? r.model], ['时长', `${r.duration} 秒`]);
      break;
    case 'image.inpaint':
      rows.push(['操作', '局部重绘']);
      break;
    case 'image.erase':
      rows.push(['操作', '消除']);
      break;
    case 'image.outpaint':
      rows.push(['操作', '扩图']);
      break;
    case 'image.removeBg':
      rows.push(['操作', '抠图']);
      break;
    case 'image.upscale':
      rows.push(['操作', `${r.scale} 倍超清`]);
      break;
    case 'custom':
      rows.push(['工作流', [...useStore.getState().workflows, ...useStore.getState().presets].find((w) => w.id === r.workflow)?.name ?? '已删除的工作流']);
      break;
  }
  return rows;
}

export function Lightbox() {
  const id = useStore((s) => s.lightboxId);
  const item = useStore((s) => s.items.find((i) => i.id === s.lightboxId));
  const tasks = useStore((s) => s.tasks);
  const close = () => useStore.setState({ lightboxId: null });

  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [id]);

  if (!item?.asset) return null;
  const r = item.request;
  const prompt = r && 'prompt' in r ? r.prompt : undefined;
  const seed = Object.values(tasks).find((t) => t.results.some((a) => a.id === item.asset!.id))?.seed;
  return (
    <div className="lightbox" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="lb-media" onPointerDown={(e) => e.target === e.currentTarget && close()}>
        {item.kind === 'image' ? (
          <img src={item.asset.url} alt="" />
        ) : (
          <video src={item.asset.url} controls autoPlay loop playsInline />
        )}
      </div>
      <div className="lb-side">
        <div className="lb-head">
          <span>详情</span>
          <button className="icon-btn" onClick={close} title="关闭 (Esc)">
            <X />
          </button>
        </div>
        {prompt && <div className="lb-prompt">{prompt}</div>}
        <div className="lb-rows">
          {r && describe(r).map(([k, v]) => (
            <div key={k} className="lb-row">
              <span>{k}</span>
              <span>{v}</span>
            </div>
          ))}
          <div className="lb-row">
            <span>尺寸</span>
            <span>
              {item.asset.width} × {item.asset.height}
            </span>
          </div>
          {seed !== undefined && (
            <div className="lb-row">
              <span>种子</span>
              <span>{seed}</span>
            </div>
          )}
        </div>
        <button className="btn primary wide" onClick={() => download(item)}>
          <Download /> 下载原图
        </button>
      </div>
    </div>
  );
}

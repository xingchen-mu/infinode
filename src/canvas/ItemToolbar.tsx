import { Brush, Camera, Clapperboard, Download, Eraser, Expand, Maximize2, Puzzle, RefreshCw, Scissors, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { CanvasItem, WorkflowLike } from '../../shared/types';
import { captureFrame, download, promptOptional, regenerate, removeBackground, runWorkflow, upscale } from '../lib/actions';
import { toScreen } from '../lib/geometry';
import { removeItems, select, setComposer, toast, useStore } from '../store';

function useFeature(key: string): { ok: boolean; why?: string } {
  const caps = useStore((s) => s.caps);
  const missing = caps?.features[key];
  if (!caps || !missing) return { ok: true };
  if (!caps.comfyOnline) return { ok: false, why: 'ComfyUI 未连接' };
  return missing.length ? { ok: false, why: `服务器缺少：${missing.join('、')}` } : { ok: true };
}

function Btn(props: { icon: React.ReactNode; label?: string; title: string; onClick: () => void; feature?: string; danger?: boolean }) {
  const f = useFeature(props.feature ?? '');
  return (
    <button
      className={`tb-btn ${props.danger ? 'danger' : ''}`}
      title={f.ok ? props.title : f.why}
      disabled={!f.ok}
      onClick={props.onClick}
    >
      {props.icon}
      {props.label && <span>{props.label}</span>}
    </button>
  );
}

/** Runs an imported workflow on this item, asking for whatever else it needs first. */
function applyTool(item: CanvasItem, wf: WorkflowLike) {
  const count = (t: string) => wf.inputs.filter((i) => i.type === t).length;
  if (count('mask')) {
    useStore.setState({ editing: { kind: 'custom', itemId: item.id, workflowId: wf.id } });
    return;
  }
  const slots = count('image') + count('video');
  if (slots > 1 || !promptOptional(wf)) {
    // Needs a prompt or more inputs: hand over to the composer with this item selected.
    select([item.id]);
    setComposer(wf.kind === 'image' ? { mode: 'image', imageModel: `custom:${wf.id}` } : { mode: 'video', videoModel: `custom:${wf.id}` });
    requestAnimationFrame(() => document.getElementById('composer-input')?.focus());
    toast(slots > 1 ? `「${wf.name}」还需要 ${slots - 1} 个输入，按顺序选中后在输入框生成` : `在输入框写提示词，然后生成「${wf.name}」`, 'info');
    return;
  }
  void runWorkflow(wf, item.kind === 'video' ? { images: [], videos: [item] } : { images: [item] });
}

export function ItemToolbar() {
  const items = useStore((s) => s.items);
  const selection = useStore((s) => s.selection);
  const viewport = useStore((s) => s.viewport);
  const screen = useStore((s) => s.screen);
  const workflows = useStore((s) => s.workflows);
  const presets = useStore((s) => s.presets);
  const caps = useStore((s) => s.caps);
  const [upscaleOpen, setUpscaleOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  if (selection.length !== 1) return null;
  const item = items.find((i) => i.id === selection[0]);
  if (!item?.asset) return null;
  // Imported workflows and runnable presets that take this kind of item as input.
  const takes = (w: WorkflowLike) => w.inputs.some((i) => i.type === (item.kind === 'video' ? 'video' : 'image'));
  const tools: WorkflowLike[] = [
    ...workflows.filter(takes),
    ...presets.filter((p) => takes(p) && caps?.comfyOnline && !caps.features[`custom:${p.id}`]?.length),
  ];
  const s = toScreen(viewport, item);
  const above = s.y - 56 >= 64;
  const top = above ? s.y - 56 : s.y + s.h + 14;
  if (top > screen.h - 120 || s.x + s.w < 0 || s.x > screen.w) return null;
  const width = (item.kind === 'image' ? 600 : 340) + (tools.length ? 90 : 0);
  const left = Math.min(Math.max(s.x + s.w / 2, width / 2 + 12), screen.w - width / 2 - 12);
  const edit = (kind: 'inpaint' | 'erase' | 'outpaint') => useStore.setState({ editing: { kind, itemId: item.id } });

  return (
    <div className="item-toolbar" data-ui style={{ left, top }} onPointerDown={(e) => e.stopPropagation()}>
      {item.kind === 'image' ? (
        <>
          <div className="tb-group">
            <Btn icon={<Sparkles />} label="超清" title="SeedVR2 超清放大" feature="image.upscale" onClick={() => setUpscaleOpen((v) => !v)} />
            {upscaleOpen && (
              <div className="tb-menu">
                {[2, 4].map((k) => (
                  <button
                    key={k}
                    onClick={() => {
                      setUpscaleOpen(false);
                      void upscale(item, k);
                    }}
                  >
                    {k} 倍超清
                    <small>
                      {Math.min(4096, item.asset!.width * k)}×{Math.min(4096, Math.round((item.asset!.height * Math.min(4096, item.asset!.width * k)) / item.asset!.width))}
                    </small>
                  </button>
                ))}
              </div>
            )}
          </div>
          <Btn icon={<Expand />} label="扩图" title="向外扩展画面" feature="image.outpaint" onClick={() => edit('outpaint')} />
          <Btn icon={<Brush />} label="局部重绘" title="涂抹区域并描述要画的内容" feature="image.inpaint" onClick={() => edit('inpaint')} />
          <Btn icon={<Eraser />} label="消除" title="涂抹要去掉的物体" feature="image.erase" onClick={() => edit('erase')} />
          <Btn icon={<Scissors />} label="抠图" title="去除背景，输出透明 PNG" feature="image.removeBg" onClick={() => void removeBackground(item)} />
          <Btn
            icon={<Clapperboard />}
            label="生视频"
            title="以这张图作为首帧生成视频"
            onClick={() => {
              setComposer({ mode: 'video' });
              document.getElementById('composer-input')?.focus();
            }}
          />
          <div className="tb-sep" />
        </>
      ) : (
        <>
          <Btn icon={<Maximize2 />} label="预览" title="带声音全屏播放（双击也可以）" onClick={() => useStore.setState({ lightboxId: item.id })} />
          <Btn icon={<Camera />} label="截取当前帧" title="把视频当前画面存成图片，可用作下一段的首帧" onClick={() => void captureFrame(item)} />
          <div className="tb-sep" />
        </>
      )}
      {tools.length > 0 && (
        <div className="tb-group">
          <Btn icon={<Puzzle />} label="我的工具" title="用导入的工作流处理它" onClick={() => setToolsOpen((v) => !v)} />
          {toolsOpen && (
            <div className="tb-menu">
              {tools.map((w) => (
                <button
                  key={w.id}
                  onClick={() => {
                    setToolsOpen(false);
                    applyTool(item, w);
                  }}
                >
                  {w.name}
                  <small>{w.inputs.some((i) => i.type === 'mask') ? '需涂抹' : w.kind === 'video' ? '视频' : '图片'}</small>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {item.request && <Btn icon={<RefreshCw />} title="用同样的设置再生成一个" onClick={() => void regenerate(item)} />}
      <Btn icon={<Download />} title="下载" onClick={() => download(item)} />
      <Btn icon={<Trash2 />} title="删除" danger onClick={() => removeItems([item.id])} />
    </div>
  );
}

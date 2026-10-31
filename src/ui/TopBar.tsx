import { Check, ChevronDown, Cloud, CloudOff, Loader2, Minus, Plus, Puzzle, Settings as SettingsIcon, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ProjectSummary, Task } from '../../shared/types';
import { fitAll } from '../lib/actions';
import { api } from '../lib/api';
import { applyTask, toast, useStore, zoomAt } from '../store';
import { createProject, openProject } from '../project';

function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open, close]);
  return ref;
}

function timeAgo(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return new Date(t).toLocaleDateString();
}

function ProjectMenu() {
  const projectId = useStore((s) => s.projectId);
  const name = useStore((s) => s.projectName);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ProjectSummary[]>([]);
  const ref = useOutsideClose(open, () => setOpen(false));

  useEffect(() => {
    if (open) void api.projects().then(setList).catch(() => {});
  }, [open]);

  return (
    <div className="project" ref={ref}>
      <input
        className="project-name"
        value={name}
        style={{ width: `${Math.min(260, Math.max(56, [...name].reduce((w, ch) => w + (/[\u2e80-\uffff]/.test(ch) ? 14 : 8), 16)))}px` }}
        onChange={(e) => useStore.setState({ projectName: e.target.value })}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        spellCheck={false}
      />
      <button className="icon-btn small" onClick={() => setOpen((v) => !v)} title="切换画布">
        <ChevronDown />
      </button>
      {open && (
        <div className="menu project-menu" data-scrollable>
          <button
            className="menu-item new"
            onClick={() => {
              setOpen(false);
              void createProject();
            }}
          >
            <Plus /> 新建画布
          </button>
          <div className="menu-sep" />
          {list.map((p) => (
            <div key={p.id} className={`project-row ${p.id === projectId ? 'on' : ''}`}>
              <button
                className="project-open"
                onClick={() => {
                  setOpen(false);
                  if (p.id !== projectId) void openProject(p.id);
                }}
              >
                <div className="project-cover">{p.cover ? <img src={p.cover} alt="" /> : null}</div>
                <div className="project-meta">
                  <span>{p.name}</span>
                  <small>
                    {p.itemCount} 个元素 · {timeAgo(p.updatedAt)}
                  </small>
                </div>
                {p.id === projectId && <Check className="dd-check" />}
              </button>
              {p.id !== projectId && (
                <button
                  className="icon-btn small danger"
                  title="删除画布"
                  onClick={async () => {
                    if (!confirm(`删除画布「${p.name}」？画布里的图片文件不会被删除。`)) return;
                    await api.deleteProject(p.id);
                    setList((l) => l.filter((x) => x.id !== p.id));
                  }}
                >
                  <Trash2 />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function opLabel(t: Task) {
  const r = t.request;
  switch (r.op) {
    case 'image.generate':
      return r.images?.length ? '参考图生成' : '文生图';
    case 'video.generate':
      return r.model === 'minimax-ref' ? '多图参考视频' : r.images?.length ? '图生视频' : '文生视频';
    case 'image.inpaint':
      return '局部重绘';
    case 'image.erase':
      return '消除';
    case 'image.outpaint':
      return '扩图';
    case 'image.removeBg':
      return '抠图';
    case 'image.upscale':
      return '超清';
    case 'custom':
      return [...useStore.getState().workflows, ...useStore.getState().presets].find((w) => w.id === r.workflow)?.name ?? '自定义工作流';
  }
}

function TaskMenu() {
  const tasks = useStore((s) => s.tasks);
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  const list = Object.values(tasks).sort((a, b) => b.createdAt - a.createdAt);
  const active = list.filter((t) => t.status === 'queued' || t.status === 'running');
  if (!list.length) return null;
  return (
    <div className="task-menu-wrap" ref={ref}>
      <button className={`pill ${active.length ? 'busy' : ''}`} onClick={() => setOpen((v) => !v)}>
        {active.length ? <Loader2 className="spin" /> : <Check />}
        {active.length ? `${active.length} 个任务进行中` : '任务'}
      </button>
      {open && (
        <div className="menu task-menu" data-scrollable>
          {list.slice(0, 30).map((t) => (
            <div key={t.id} className={`task-row ${t.status}`}>
              <div className="task-main">
                <div className="task-title">
                  <span>{opLabel(t)}</span>
                  <small>{'prompt' in t.request && t.request.prompt ? t.request.prompt : ''}</small>
                </div>
                <div className="task-status">
                  {t.status === 'done' ? '完成' : t.status === 'error' ? t.error ?? '失败' : t.status === 'cancelled' ? '已取消' : t.stage ?? '排队中'}
                </div>
                {(t.status === 'running' || t.status === 'queued') && (
                  <div className="task-progress">
                    <div style={{ width: `${Math.round(t.progress * 100)}%` }} />
                  </div>
                )}
              </div>
              {(t.status === 'running' || t.status === 'queued') && (
                <button
                  className="icon-btn small"
                  title="取消"
                  onClick={async () => {
                    try {
                      applyTask(await api.cancelTask(t.id));
                    } catch (err) {
                      toast((err as Error).message, 'error');
                    }
                  }}
                >
                  <X />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ZoomControl() {
  const zoom = useStore((s) => s.viewport.zoom);
  const screen = useStore((s) => s.screen);
  const step = (k: number) => zoomAt(screen.w / 2, screen.h / 2, zoom * k);
  return (
    <div className="zoom">
      <button className="icon-btn small" onClick={() => step(1 / 1.25)} title="缩小 (⌘-)">
        <Minus />
      </button>
      <button className="zoom-val" onClick={fitAll} title="适应画布 (⇧1)">
        {Math.round(zoom * 100)}%
      </button>
      <button className="icon-btn small" onClick={() => step(1.25)} title="放大 (⌘=)">
        <Plus />
      </button>
    </div>
  );
}

export function TopBar() {
  const caps = useStore((s) => s.caps);
  const comfyOnline = useStore((s) => s.comfyOnline);
  const serverOnline = useStore((s) => s.serverOnline);
  const saveState = useStore((s) => s.saveState);
  return (
    <>
      <div className="topbar left" data-ui>
        <div className="logo" title="Infinode">
          <svg viewBox="0 0 32 32" width="22" height="22">
            <rect width="32" height="32" rx="8" fill="#23252b" />
            <path d="M8 23l5.5-7.5 4 5 3-3.2L25 23z" fill="#b8f36b" />
            <circle cx="21.5" cy="10.5" r="2.6" fill="#b8f36b" />
          </svg>
        </div>
        <ProjectMenu />
        <span className={`save-state ${saveState}`}>{saveState === 'saving' ? '保存中…' : saveState === 'error' ? '保存失败' : '已保存'}</span>
      </div>
      <div className="topbar right" data-ui>
        <TaskMenu />
        <button className="pill" onClick={() => useStore.setState({ modal: { type: 'workflows' } })} title="导入和管理自己的 ComfyUI 工作流">
          <Puzzle /> 我的工作流
        </button>
        <button
          className={`pill status ${serverOnline && comfyOnline ? 'ok' : 'bad'}`}
          onClick={() => useStore.setState({ modal: { type: 'settings' } })}
          title={!serverOnline ? '本地服务未连接' : comfyOnline ? `ComfyUI ${caps?.comfyVersion ?? ''}` : 'ComfyUI 未连接：检查 SSH 隧道和服务器上的 ComfyUI'}
        >
          {serverOnline && comfyOnline ? <Cloud /> : <CloudOff />}
          {!serverOnline ? '本地服务未连接' : comfyOnline ? caps?.gpu ?? 'ComfyUI 已连接' : 'ComfyUI 未连接'}
          <SettingsIcon className="pill-gear" />
        </button>
        <ZoomControl />
      </div>
    </>
  );
}

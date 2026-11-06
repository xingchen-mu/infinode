import { Check, ChevronDown, Cloud, CloudOff, History, Images, Loader2, Minus, Plus, Puzzle, Settings as SettingsIcon, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { thumbUrl } from '../../shared/media';
import type { ProjectSummary, Task } from '../../shared/types';
import { fitAll } from '../canvas/view';
import { api } from '../lib/api';
import { applyTask, toast, useStore, zoomAt } from '../store';
import { createProject, openProject } from './sync';
import { AgentButton } from '../assistant/AgentPanel';
import { t } from '../i18n';

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

function timeAgo(at: number) {
  const s = (Date.now() - at) / 1000;
  if (s < 60) return t('刚刚');
  if (s < 3600) return t('{n} 分钟前', { n: Math.floor(s / 60) });
  if (s < 86400) return t('{n} 小时前', { n: Math.floor(s / 3600) });
  return new Date(at).toLocaleDateString();
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
      <button className="icon-btn small" onClick={() => setOpen((v) => !v)} title={t('切换画布')}>
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
            <Plus /> {t('新建画布')}
          </button>
          {projectId && <button className="menu-item" onClick={() => { setOpen(false); useStore.setState({ modal: { type: 'snapshots' } }); }}><History /> {t('项目快照')}</button>}
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
                <div className="project-cover">{p.cover ? <img src={thumbUrl(p.cover)} alt="" /> : null}</div>
                <div className="project-meta">
                  <span>{p.name}</span>
                  <small>
                    {t('{n} 个元素 · {ago}', { n: p.itemCount, ago: timeAgo(p.updatedAt) })}
                  </small>
                </div>
                {p.id === projectId && <Check className="dd-check" />}
              </button>
              {p.id !== projectId && (
                <button
                  className="icon-btn small danger"
                  title={t('删除画布')}
                  onClick={async () => {
                    if (!confirm(t('删除画布「{name}」？画布里的图片文件不会被删除。', { name: p.name }))) return;
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

function opLabel(task: Task) {
  const r = task.request;
  switch (r.op) {
    case 'image.generate':
      return r.images?.length ? t('参考图生成') : t('文生图');
    case 'video.generate':
      return r.model === 'minimax-ref' ? t('多图参考视频') : r.images?.length ? t('图生视频') : t('文生视频');
    case 'image.inpaint':
      return t('局部重绘');
    case 'image.erase':
      return t('消除');
    case 'image.outpaint':
      return t('扩图');
    case 'image.removeBg':
      return t('抠图');
    case 'image.upscale':
      return t('超清');
    case 'custom':
      return t([...useStore.getState().workflows, ...useStore.getState().presets].find((w) => w.id === r.workflow)?.name ?? '自定义工作流');
  }
}

function TaskMenu() {
  const tasks = useStore((s) => s.tasks);
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  const list = Object.values(tasks).sort((a, b) => b.createdAt - a.createdAt);
  const active = list.filter((task) => task.status === 'queued' || task.status === 'running');
  if (!list.length) return null;
  return (
    <div className="task-menu-wrap" ref={ref}>
      <button className={`pill ${active.length ? 'busy' : ''}`} onClick={() => setOpen((v) => !v)}>
        {active.length ? <Loader2 className="spin" /> : <Check />}
        {active.length ? t('{n} 个任务进行中', { n: active.length }) : t('任务')}
      </button>
      {open && (
        <div className="menu task-menu" data-scrollable>
          {list.slice(0, 30).map((task) => (
            <div key={task.id} className={`task-row ${task.status}`}>
              <div className="task-main">
                <div className="task-title">
                  <span>{opLabel(task)}</span>
                  <small>{'prompt' in task.request && task.request.prompt ? task.request.prompt : ''}</small>
                </div>
                <div className="task-status">
                  {task.status === 'done' ? t('完成') : task.status === 'error' ? t(task.error ?? '失败') : task.status === 'cancelled' ? t('已取消') : (task.stage ?? t('排队中'))}
                </div>
                {(task.status === 'running' || task.status === 'queued') && (
                  <div className="task-progress">
                    <div style={{ width: `${Math.round(task.progress * 100)}%` }} />
                  </div>
                )}
              </div>
              {(task.status === 'running' || task.status === 'queued') && (
                <button
                  className="icon-btn small"
                  title={t('取消')}
                  onClick={async () => {
                    try {
                      applyTask(await api.cancelTask(task.id));
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
      <button className="icon-btn small" onClick={() => step(1 / 1.25)} title={t('缩小 (⌘-)')}>
        <Minus />
      </button>
      <button className="zoom-val" onClick={fitAll} title={t('适应画布 (⇧1)')}>
        {Math.round(zoom * 100)}%
      </button>
      <button className="icon-btn small" onClick={() => step(1.25)} title={t('放大 (⌘=)')}>
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
        <span className={`save-state ${saveState}`}>{saveState === 'saving' ? t('保存中…') : saveState === 'error' ? t('保存失败') : t('已保存')}</span>
      </div>
      <div className="topbar right" data-ui>
        <AgentButton />
        <TaskMenu />
        <button className="pill" onClick={() => useStore.setState({ modal: { type: 'workflows' } })} title={t('导入和管理自己的 ComfyUI 工作流')}>
          <Puzzle /> {t('我的工作流')}
        </button>
        <button className="pill" onClick={() => useStore.setState({ modal: { type: 'assets' } })} title={t('浏览和管理已上传或生成的图片、视频')}>
          <Images /> {t('资产库')}
        </button>
        <button
          className={`pill status ${serverOnline && comfyOnline ? 'ok' : 'bad'}`}
          onClick={() => useStore.setState({ modal: { type: 'settings' } })}
          title={!serverOnline ? t('本地服务未连接') : comfyOnline ? `ComfyUI ${caps?.comfyVersion ?? ''}` : t('ComfyUI 未连接：检查 SSH 隧道和服务器上的 ComfyUI')}
        >
          {serverOnline && comfyOnline ? <Cloud /> : <CloudOff />}
          {!serverOnline ? t('本地服务未连接') : comfyOnline ? caps?.gpu ?? t('ComfyUI 已连接') : t('ComfyUI 未连接')}
          <SettingsIcon className="pill-gear" />
        </button>
        <ZoomControl />
      </div>
    </>
  );
}

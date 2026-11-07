import { AlertTriangle, CheckCircle2, Copy, Download, HardDrive, Loader2, Server, Terminal, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { formatBytes } from '../../shared/media';
import type { ModelDownloadJob, ModelInstallInfo, ModelInstallMode, ModelInstallPlan, ModelSource } from '../../shared/types';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { t } from '../i18n';
import { type Modal as ModalState, toast, useStore } from '../store';
import { activeDownload } from './actions';

const SOURCES: { id: ModelSource; label: string }[] = [
  { id: 'auto', label: t('自动') },
  { id: 'huggingface', label: 'Hugging Face' },
  { id: 'hf-mirror', label: t('hf-mirror 镜像') },
  { id: 'custom', label: t('自定义') },
];

export function sourceHelp(source: ModelSource, endpoint?: string): string {
  if (source === 'auto') return t('中文界面先试 hf-mirror.com，连不上再试 huggingface.co（英文界面反过来），并记住能用的那个。自动模式下 token 只发给 huggingface.co。');
  if (source === 'huggingface') return t('直接从 huggingface.co 下载。');
  if (source === 'hf-mirror') return t('从国内镜像 hf-mirror.com 下载。填了 Hugging Face token 时，token 会经过镜像站。');
  return t('从 {endpoint} 下载（需兼容 Hugging Face 的 /<仓库>/resolve/<版本>/<文件> 地址）。', { endpoint: endpoint || t('自定义地址') });
}

/** Where downloaded files end up, in one line. */
export function modeLine(info: { mode: ModelInstallMode; host?: string; reason?: string }): string {
  if (info.mode === 'local') return t('直接写入这台电脑上 ComfyUI 的模型目录');
  if (info.mode === 'ssh') return t('通过 SSH 让服务器 {host} 自己下载到 ComfyUI 的模型目录', { host: info.host ?? '' });
  return info.reason ?? t('无法自动下载');
}

/** Download source buttons; saving one applies to the next download. */
export function SourcePicker({ value, endpoint, onChange, disabled }: { value: ModelSource; endpoint?: string; onChange: (s: ModelSource) => void; disabled?: boolean }) {
  return (
    <div className="seg">
      {SOURCES.filter((s) => s.id !== 'custom' || value === 'custom' || endpoint).map((s) => (
        <button key={s.id} className={value === s.id ? 'on' : ''} disabled={disabled} onClick={() => value !== s.id && onChange(s.id)}>
          {s.label}
        </button>
      ))}
    </div>
  );
}

function remaining(job: ModelDownloadJob): string | undefined {
  if (!job.speed || !job.total || job.speed < 1) return undefined;
  const s = (job.total - job.received) / job.speed;
  if (s < 60) return t('不到 1 分钟');
  if (s < 3600) return t('约 {n} 分钟', { n: Math.ceil(s / 60) });
  return t('约 {h} 小时 {m} 分', { h: Math.floor(s / 3600), m: Math.round((s % 3600) / 60) });
}

export function JobProgress({ job }: { job: ModelDownloadJob }) {
  const pct = job.total ? Math.min(100, (job.received / job.total) * 100) : undefined;
  const cancel = () => void api.cancelDownload(job.id).catch((err) => toast((err as Error).message, 'error'));
  if (job.status === 'done') {
    return (
      <div className="dl-state ok">
        <CheckCircle2 /> {job.existed ? t('已在 ComfyUI 的模型目录里') : t('已下载 {size}', { size: formatBytes(job.received) })}
        {job.source && <span className="dl-dim"> · {job.source}</span>}
      </div>
    );
  }
  if (job.status === 'error') return <div className="dl-state bad"><AlertTriangle /> {job.error}</div>;
  if (job.status === 'cancelled') return <div className="dl-state">{t('已取消（已下载的部分会保留，下次接着下载）')}</div>;
  const eta = remaining(job);
  return (
    <div className="dl-progress">
      <div className="dl-bar">
        <div style={{ width: `${pct ?? 0}%` }} className={pct === undefined ? 'unknown' : ''} />
      </div>
      <div className="dl-meta">
        <span>
          {job.status === 'queued'
            ? t('排队中')
            : pct === undefined
              ? formatBytes(job.received)
              : `${pct.toFixed(pct < 10 ? 1 : 0)}% · ${formatBytes(job.received)} / ${formatBytes(job.total!)}`}
          {job.speed ? ` · ${formatBytes(job.speed)}/s` : ''}
          {eta ? ` · ${t('剩余 {eta}', { eta })}` : ''}
        </span>
        <button className="icon-btn small" title={t('取消下载')} onClick={cancel}>
          <X />
        </button>
      </div>
    </div>
  );
}

/** The newest download of a file. */
function latestJob(jobs: Record<string, ModelDownloadJob>, name: string, directory: string) {
  return Object.values(jobs)
    .filter((j) => j.name === name && j.directory === directory)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

function ModeIcon({ mode }: { mode: ModelInstallMode }) {
  if (mode === 'local') return <HardDrive />;
  if (mode === 'ssh') return <Server />;
  return <Terminal />;
}

export function DownloadsModal({ names, title, back }: { names: string[]; title?: string; back?: ModalState }) {
  const downloads = useStore((s) => s.downloads);
  const [info, setInfo] = useState<ModelInstallInfo | null>(null);
  const [plan, setPlan] = useState<ModelInstallPlan | null>(null);
  const [planError, setPlanError] = useState('');
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const close = useCallback(() => useStore.setState({ modal: back ?? null }), [back]);

  const load = useCallback(async () => {
    setLoading(true);
    setPlanError('');
    try {
      const [i, p] = await Promise.all([api.modelInstall(), names.length ? api.planModels(names) : Promise.resolve(null)]);
      setInfo(i);
      setPlan(p);
    } catch (err) {
      setPlanError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [names]);
  useEffect(() => void load(), [load]);

  const switchSource = async (source: ModelSource) => {
    try {
      await api.saveSettings({ modelSource: source });
      await load();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const rows = (plan?.files ?? []).map((f) => ({ ...f, job: latestJob(downloads, f.name, f.directory) }));
  const canInstall = plan?.mode === 'local' || plan?.mode === 'ssh';
  const todo = rows.filter((r) => !r.exists && !(r.job && (activeDownload(r.job) || r.job.status === 'done')));
  const todoSize = todo.reduce((n, r) => n + (r.size ?? 0), 0);
  const unknownSize = todo.some((r) => r.size === undefined);
  const allDone = rows.length > 0 && rows.every((r) => r.exists || r.job?.status === 'done');
  const others = Object.values(downloads)
    .filter((j) => !rows.some((r) => r.name === j.name && r.directory === j.directory))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 12);

  const start = async () => {
    setStarting(true);
    try {
      const jobs = await api.downloadModels(todo.map((r) => r.name));
      useStore.setState((s) => ({ downloads: { ...s.downloads, ...Object.fromEntries(jobs.map((j) => [j.id, j])) } }));
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setStarting(false);
    }
  };

  const copyCommands = async () => {
    try {
      await navigator.clipboard.writeText(plan?.commands ?? '');
      toast(t('已复制下载命令'), 'success');
    } catch {
      toast(t('复制失败，请手动选中命令复制'), 'error');
    }
  };

  const mode = plan ?? info;
  return (
    <Modal
      title={
        <>
          {names.length ? t('下载模型') : t('模型下载记录')}
          {title && <span className="m-help title-sub">{title}</span>}
        </>
      }
      onClose={close}
      wide
      footer={
        <>
          <span className="m-help">
            {canInstall && todo.length > 0 &&
              (todoSize > 0
                ? t('共 {n} 个文件 · {size}', { n: todo.length, size: unknownSize ? t('{size} 以上', { size: formatBytes(todoSize) }) : formatBytes(todoSize) })
                : t('共 {n} 个文件', { n: todo.length }))}
            {canInstall && plan?.free !== undefined && ` · ${t('剩余空间 {free}', { free: formatBytes(plan.free) })}`}
          </span>
          <div className="grow" />
          <button className="btn ghost" onClick={close}>
            {back ? t('返回') : t('关闭')}
          </button>
          {names.length > 0 && canInstall && !allDone && (
            <button className="btn primary" onClick={() => void start()} disabled={starting || loading || !todo.length}>
              {starting ? <Loader2 className="spin" /> : <Download />} {t('开始下载')}
            </button>
          )}
          {names.length > 0 && !canInstall && plan?.commands && (
            <button className="btn primary" onClick={() => void copyCommands()}>
              <Copy /> {t('复制下载命令')}
            </button>
          )}
        </>
      }
    >
      <section className="m-section">
        {mode && (
          <div className={`dl-mode ${mode.mode === 'local' || mode.mode === 'ssh' ? 'ok' : 'bad'}`}>
            <ModeIcon mode={mode.mode} />
            <span>{modeLine(mode)}</span>
          </div>
        )}
        {info && (
          <div className="m-row dl-source">
            <span className="m-label">{t('下载源')}</span>
            <SourcePicker value={info.source} endpoint={info.endpoint} onChange={(s) => void switchSource(s)} disabled={loading} />
          </div>
        )}
        {info && <div className="m-help">{sourceHelp(info.source, info.endpoint)}</div>}
      </section>

      {loading && !plan && names.length > 0 && (
        <div className="m-help dl-loading">
          <Loader2 className="spin" /> {mode?.mode === 'ssh' ? t('正在服务器上检查文件和下载源…') : t('正在检查文件和下载源…')}
        </div>
      )}
      {planError && <div className="m-result bad">{planError}</div>}

      {rows.length > 0 && (
        <section className="m-section dl-files">
          {rows.map((r) => (
            <div key={`${r.directory}/${r.name}`} className="dl-file">
              <div className="dl-head">
                <code className="dl-name">{r.name}</code>
                <span className="dl-size">{r.size !== undefined ? formatBytes(r.size) : ''}</span>
              </div>
              <div className="dl-path" title={r.path}>{r.path}</div>
              {r.job ? (
                <JobProgress job={r.job} />
              ) : r.exists ? (
                <div className="dl-state ok"><CheckCircle2 /> {t('已在 ComfyUI 的模型目录里')}</div>
              ) : r.error ? (
                <div className="dl-state bad"><AlertTriangle /> {r.error}</div>
              ) : (
                <div className="dl-dim dl-url" title={r.url}>{r.url}</div>
              )}
            </div>
          ))}
        </section>
      )}

      {plan && !canInstall && plan.commands && (
        <section className="m-section">
          <div className="m-help">{t('在 ComfyUI 所在的电脑上运行这些命令（需要 curl），下完后刷新即可：')}</div>
          <pre className="dl-commands">{plan.commands}</pre>
        </section>
      )}

      {(others.length > 0 || !names.length) && (
        <section className="m-section dl-files">
          <div className="m-label">{names.length ? t('其它下载') : t('最近的下载')}</div>
          {!others.length && <div className="m-help">{t('还没有下载过模型。在模板库或设置里缺模型的工具上可以一键下载。')}</div>}
          {others.map((j) => (
            <div key={j.id} className="dl-file">
              <div className="dl-head">
                <code className="dl-name">{j.name}</code>
                <span className="dl-size">{j.total ? formatBytes(j.total) : ''}</span>
              </div>
              {j.path && <div className="dl-path" title={j.path}>{j.path}</div>}
              <JobProgress job={j} />
            </div>
          ))}
        </section>
      )}
    </Modal>
  );
}

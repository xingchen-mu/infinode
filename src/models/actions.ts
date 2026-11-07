import type { ModelDownloadJob } from '../../shared/types';
import { api } from '../lib/api';
import { t } from '../i18n';
import { toast, useStore } from '../store';
import { loadWorkflows } from '../workflows/actions';

export const activeDownload = (j: ModelDownloadJob) => j.status === 'queued' || j.status === 'running';

let refreshTimer: ReturnType<typeof setTimeout> | undefined;

/** A file landed: ComfyUI may run more tools and templates now. */
function refreshAfterInstall() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      const caps = await api.capabilities(true);
      useStore.setState({ caps, comfyOnline: caps.comfyOnline });
      await loadWorkflows();
    } catch {
      /* server offline */
    }
  }, 1200);
}

export function applyDownload(job: ModelDownloadJob) {
  const prev = useStore.getState().downloads[job.id];
  useStore.setState((s) => ({ downloads: { ...s.downloads, [job.id]: job } }));
  if (prev?.status === job.status) return;
  if (job.status === 'done') {
    refreshAfterInstall();
    if (!Object.values(useStore.getState().downloads).some(activeDownload)) toast(t('模型下载完成，ComfyUI 已能找到它们'), 'success');
  }
  if (job.status === 'error') toast(t('{name} 下载失败：{error}', { name: job.name, error: job.error ?? '' }), 'error');
}

export async function loadDownloads() {
  try {
    const jobs = await api.modelDownloads();
    useStore.setState({ downloads: Object.fromEntries(jobs.map((j) => [j.id, j])) });
  } catch {
    /* server offline */
  }
}

/** Opens the download dialog for these files, coming back to `back` when it closes. */
export function openDownloads(names: string[], title?: string) {
  const back = useStore.getState().modal;
  useStore.setState({ modal: { type: 'downloads', names, title, back: back?.type === 'downloads' ? back.back : back } });
}

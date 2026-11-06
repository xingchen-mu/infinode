import { Copy, GitBranch, History, Loader2, Plus, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ProjectSnapshotSummary } from '../../shared/types';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { savePending, openProject } from './sync';
import { toast, useStore } from '../store';
import { t } from '../i18n';

const close = () => useStore.setState({ modal: null });

function when(at: number) {
  return new Date(at).toLocaleString();
}

export function SnapshotsModal() {
  const projectId = useStore((s) => s.projectId);
  const projectName = useStore((s) => s.projectName);
  const [snapshots, setSnapshots] = useState<ProjectSnapshotSummary[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (projectId) void api.projectSnapshots(projectId).then(setSnapshots).catch((err) => toast((err as Error).message, 'error'));
  }, [projectId]);

  const create = async () => {
    if (!projectId) return;
    setBusy('create');
    try {
      await savePending();
      const snapshot = await api.createSnapshot(projectId, name.trim() || t('当前版本'));
      setSnapshots((list) => [snapshot, ...list]);
      setName('');
      toast(t('快照已保存'), 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const restore = async (snapshot: ProjectSnapshotSummary) => {
    if (!projectId || !confirm(t('恢复快照「{name}」？当前未保存的画布改动会先保存。', { name: snapshot.name }))) return;
    setBusy(snapshot.id);
    try {
      await savePending();
      await api.restoreSnapshot(projectId, snapshot.id);
      await openProject(projectId);
      close();
      toast(t('已恢复快照'), 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const branch = async (snapshot: ProjectSnapshotSummary) => {
    if (!projectId) return;
    setBusy(`branch:${snapshot.id}`);
    try {
      await savePending();
      const project = await api.branchProject(projectId, snapshot.id, `${snapshot.name} · ${t('分支')}`);
      await openProject(project.id);
      close();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title={<><History /> {t('项目快照')}</>} onClose={close}>
      <section className="m-section">
        <div className="m-help">{t('保存当前画布的完整状态，之后可以恢复，或从它复制出一条新分支。')}</div>
        <div className="m-row">
          <input className="m-input" value={name} placeholder={t('快照名称，例如：角色设定完成')} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
          <button className="btn primary" onClick={() => void create()} disabled={!projectId || busy !== null}>{busy === 'create' ? <Loader2 className="spin" /> : <Plus />}{t('保存快照')}</button>
        </div>
        <div className="m-help">{t('当前项目：{name}', { name: projectName })}</div>
      </section>
      <section className="m-section snapshot-list">
        <div className="m-label">{t('历史快照')}</div>
        {!snapshots.length && <div className="m-help">{t('还没有快照，先保存一个版本。')}</div>}
        {snapshots.map((snapshot) => (
          <div className="snapshot-row" key={snapshot.id}>
            <div className="snapshot-meta">
              <b>{snapshot.name}</b>
              <small>{when(snapshot.createdAt)} · {t('{n} 个元素', { n: snapshot.itemCount })}</small>
            </div>
            <div className="m-row">
              <button className="btn ghost small" onClick={() => void restore(snapshot)} disabled={busy !== null}><RotateCcw /> {t('恢复')}</button>
              <button className="btn ghost small" onClick={() => void branch(snapshot)} disabled={busy !== null}><GitBranch /> {t('创建分支')}</button>
            </div>
            {busy === snapshot.id && <Loader2 className="spin" />}
            {busy === `branch:${snapshot.id}` && <Copy className="spin" />}
          </div>
        ))}
      </section>
    </Modal>
  );
}

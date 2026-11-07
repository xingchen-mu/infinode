import { useStore } from './store';
import { SettingsModal } from './settings/SettingsModal';
import { WorkflowsModal } from './workflows/WorkflowsModal';
import { WorkflowEditor } from './workflows/WorkflowEditor';
import { PresetsModal } from './workflows/PresetsModal';
import { AssetsModal } from './assets/AssetsModal';
import { ItemDetailsModal } from './canvas/ItemDetailsModal';
import { SnapshotsModal } from './projects/SnapshotsModal';
import { OnboardingModal } from './onboarding/OnboardingModal';
import { DownloadsModal } from './models/DownloadsModal';

export function Modals() {
  const modal = useStore((s) => s.modal);
  if (!modal) return null;
  if (modal.type === 'settings') return <SettingsModal />;
  if (modal.type === 'workflows') return <WorkflowsModal />;
  if (modal.type === 'presets') return <PresetsModal />;
  if (modal.type === 'assets') return <AssetsModal />;
  if (modal.type === 'details') return <ItemDetailsModal itemId={modal.itemId} />;
  if (modal.type === 'snapshots') return <SnapshotsModal />;
  if (modal.type === 'onboarding') return <OnboardingModal />;
  if (modal.type === 'downloads') return <DownloadsModal key={modal.names.join('\n')} names={modal.names} title={modal.title} back={modal.back} />;
  return <WorkflowEditor key={modal.id ?? 'new'} draft={modal.draft} id={modal.id} />;
}

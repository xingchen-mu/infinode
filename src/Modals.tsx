import { useStore } from './store';
import { SettingsModal } from './settings/SettingsModal';
import { WorkflowsModal } from './workflows/WorkflowsModal';
import { WorkflowEditor } from './workflows/WorkflowEditor';
import { PresetsModal } from './workflows/PresetsModal';
import { AssetsModal } from './assets/AssetsModal';

export function Modals() {
  const modal = useStore((s) => s.modal);
  if (!modal) return null;
  if (modal.type === 'settings') return <SettingsModal />;
  if (modal.type === 'workflows') return <WorkflowsModal />;
  if (modal.type === 'presets') return <PresetsModal />;
  if (modal.type === 'assets') return <AssetsModal />;
  return <WorkflowEditor key={modal.id ?? 'new'} draft={modal.draft} id={modal.id} />;
}

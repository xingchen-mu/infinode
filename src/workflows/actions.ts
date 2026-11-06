import type { AssetInfo, CanvasItem, WorkflowLike } from '../../shared/types';
import { setWorkflows, useStore } from '../store';
import { api } from '../lib/api';
import { displaySize } from '../../shared/geometry';
import { aspectValue } from '../generation/models';
import { IMAGE_LONG_SIDE, VIDEO_LONG_SIDE } from '../canvas/items';
import { launch } from '../generation/tasks';

const get = useStore.getState;

/** Imported workflows and official template presets, by id. */
export function findWorkflow(id: string): WorkflowLike | undefined {
  const { workflows, presets } = get();
  return workflows.find((w) => w.id === id) ?? presets.find((p) => p.id === id);
}

/** The imported workflow or preset the composer currently points at, if any. */
export function activeWorkflow(): WorkflowLike | undefined {
  const { composer } = get();
  const id = composer.mode === 'image' ? composer.imageModel : composer.videoModel;
  return id.startsWith('custom:') ? findWorkflow(id.slice(7)) : undefined;
}
/** Runs an imported workflow with the given board items as its image/video inputs. */
export async function runWorkflow(
  wf: WorkflowLike,
  opts: { prompt?: string; images: CanvasItem[]; videos?: CanvasItem[]; mask?: AssetInfo; aspect?: string; count?: number },
) {
  const { composer } = get();
  const first = opts.images[0]?.asset;
  const hasSize = wf.inputs.some((i) => i.type === 'width') && wf.inputs.some((i) => i.type === 'height');
  const aspect = hasSize ? (opts.aspect ?? 'auto') : 'auto';
  const widthInput = wf.inputs.find((i) => i.type === 'width');
  const heightInput = wf.inputs.find((i) => i.type === 'height');
  const defaultRatio = Number(widthInput?.default) / Number(heightInput?.default);
  const ratio =
    aspectValue(aspect) ??
    (first ? first.width / first.height : Number.isFinite(defaultRatio) && defaultRatio > 0 ? defaultRatio : wf.kind === 'video' ? 16 / 9 : 1);
  await launch({
    request: {
      op: 'custom',
      workflow: wf.id,
      prompt: opts.prompt,
      images: opts.images.map((i) => i.asset!.id),
      videos: (opts.videos ?? []).map((i) => i.asset!.id),
      mask: opts.mask?.id,
      aspect,
      params: composer.params[wf.id] ?? {},
    },
    kind: wf.kind,
    count: opts.count ?? 1,
    size: displaySize(ratio, 1, wf.kind === 'video' ? VIDEO_LONG_SIDE : IMAGE_LONG_SIDE),
    inputs: [...opts.images, ...(opts.videos ?? [])],
  });
}

/** Whether a workflow can run without the user typing a prompt (none needed, or it has a default). */
export function promptOptional(wf: WorkflowLike) {
  const p = wf.inputs.find((i) => i.type === 'prompt');
  return !p || Boolean(String(p.default ?? '').trim());
}
/** Imported workflows and presets from the server into the store. */
export async function loadWorkflows() {
  try {
    const [workflows, presets] = await Promise.all([api.workflows(), api.presets()]);
    setWorkflows(workflows, presets);
  } catch {
    /* server offline */
  }
}

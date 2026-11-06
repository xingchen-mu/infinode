import { type ComposerSettings, loadComposer, saveComposer } from './generation/settings';
import { create } from 'zustand';
import type { Capabilities, CanvasItem, CustomWorkflow, PresetInfo, Task, Viewport, WorkflowDraft } from '../shared/types';
import { msg } from '../shared/i18n';

export type Tool = 'select' | 'hand';
export interface EditMode {
  kind: 'inpaint' | 'erase' | 'outpaint' | 'custom';
  itemId: string;
  /** For kind 'custom': the imported workflow that takes the mask. */
  workflowId?: string;
}

export type Modal = null | { type: 'settings' } | { type: 'workflows' } | { type: 'presets' } | { type: 'assets' } | { type: 'editor'; draft: WorkflowDraft; id?: string };
export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error' | 'success';
}

export interface State {
  projectId: string | null;
  projectName: string;
  items: CanvasItem[];
  viewport: Viewport;
  selection: string[];
  tool: Tool;
  spaceHeld: boolean;
  tasks: Record<string, Task>;
  caps: Capabilities | null;
  comfyOnline: boolean;
  serverOnline: boolean;
  editing: EditMode | null;
  composer: ComposerSettings;
  prompt: string;
  past: CanvasItem[][];
  future: CanvasItem[][];
  toasts: Toast[];
  lightboxId: string | null;
  saveState: 'saved' | 'saving' | 'error';
  screen: { w: number; h: number };
  /** Draw lines from inputs to the results made from them. */
  showLinks: boolean;
  /** Output slot dragged out of an item: the next generation using it lands here. */
  pendingOutput: { from: string; at: { x: number; y: number } } | null;
  workflows: CustomWorkflow[];
  presets: PresetInfo[];
  modal: Modal;
  /** Text item open for editing on the board. */
  noteEditing: string | null;
}

// Carry over settings saved before the project was renamed from Comfy Canva.
for (const key of ['last-project', 'composer', 'links']) {
  const old = localStorage.getItem(`comfy-canva:${key}`);
  if (old === null) continue;
  if (localStorage.getItem(`infinode:${key}`) === null) localStorage.setItem(`infinode:${key}`, old);
  localStorage.removeItem(`comfy-canva:${key}`);
}

export const useStore = create<State>(() => ({
  projectId: null,
  projectName: '',
  items: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  selection: [],
  tool: 'select',
  spaceHeld: false,
  tasks: {},
  caps: null,
  comfyOnline: false,
  serverOnline: true,
  editing: null,
  composer: loadComposer(),
  prompt: '',
  past: [],
  future: [],
  toasts: [],
  lightboxId: null,
  saveState: 'saved',
  screen: { w: window.innerWidth, h: window.innerHeight },
  showLinks: localStorage.getItem('infinode:links') !== 'off',
  pendingOutput: null,
  workflows: [],
  presets: [],
  modal: null,
  noteEditing: null,
}));

export function setShowLinks(on: boolean) {
  useStore.setState({ showLinks: on });
  localStorage.setItem('infinode:links', on ? 'on' : 'off');
}

const set = useStore.setState;
const get = useStore.getState;

const HISTORY_LIMIT = 100;

/** Fills finished placeholders with their results. */
export function resolveItems(items: CanvasItem[], tasks: Record<string, Task>): CanvasItem[] {
  let changed = false;
  const out = items.map((it) => {
    if (!it.taskId) return it;
    const task = tasks[it.taskId];
    if (!task) return it;
    if (task.status === 'done') {
      const asset = task.results[it.resultIndex ?? 0] ?? task.results[0];
      changed = true;
      if (!asset) return { ...it, taskId: undefined, error: msg('没有返回结果') };
      const aspect = asset.width / asset.height;
      const h = Math.abs(it.w / it.h - aspect) > 0.01 ? Math.round(it.w / aspect) : it.h;
      return { ...it, kind: asset.kind, taskId: undefined, error: undefined, asset, h, y: it.y + (it.h - h) / 2 };
    }
    if ((task.status === 'error' || task.status === 'cancelled') && !it.error) {
      changed = true;
      return { ...it, error: task.status === 'cancelled' ? msg('已取消') : (task.error ?? msg('生成失败')) };
    }
    return it;
  });
  return changed ? out : items;
}

/** Replaces items and records an undo step. */
export function commit(items: CanvasItem[]) {
  const { items: prev, past } = get();
  if (items === prev) return;
  set({ items, past: [...past.slice(-HISTORY_LIMIT + 1), prev], future: [] });
}

export function updateItems(fn: (items: CanvasItem[]) => CanvasItem[], record = true) {
  const next = fn(get().items);
  if (record) commit(next);
  else set({ items: next });
}

export function patchItem(id: string, patch: Partial<CanvasItem>, record = false) {
  updateItems((items) => items.map((it) => (it.id === id ? { ...it, ...patch } : it)), record);
}

/** For drags: call at the start, then `endGesture` with the snapshot when done. */
export function beginGesture() {
  return get().items;
}

export function endGesture(snapshot: CanvasItem[]) {
  const { items, past } = get();
  if (items !== snapshot) set({ past: [...past.slice(-HISTORY_LIMIT + 1), snapshot], future: [] });
}

export function undo() {
  const { past, future, items, tasks } = get();
  if (!past.length) return;
  const prev = past[past.length - 1];
  const ids = new Set(prev.map((i) => i.id));
  set({
    items: resolveItems(prev, tasks),
    past: past.slice(0, -1),
    future: [items, ...future],
    selection: get().selection.filter((id) => ids.has(id)),
  });
}

export function redo() {
  const { past, future, items, tasks } = get();
  if (!future.length) return;
  const [next, ...rest] = future;
  const ids = new Set(next.map((i) => i.id));
  set({
    items: resolveItems(next, tasks),
    past: [...past, items],
    future: rest,
    selection: get().selection.filter((id) => ids.has(id)),
  });
}

export function select(ids: string[], mode: 'replace' | 'add' | 'toggle' = 'replace') {
  const current = get().selection;
  let next: string[];
  if (mode === 'replace') next = ids;
  else if (mode === 'add') next = [...current, ...ids.filter((id) => !current.includes(id))];
  else {
    next = [...current];
    for (const id of ids) {
      const i = next.indexOf(id);
      if (i >= 0) next.splice(i, 1);
      else next.push(id);
    }
  }
  if (next.length === current.length && next.every((id, i) => id === current[i])) return;
  const { pendingOutput } = get();
  set({ selection: next, ...(pendingOutput && !next.includes(pendingOutput.from) ? { pendingOutput: null } : {}) });
}

export function removeItems(ids: string[]) {
  const drop = new Set(ids);
  updateItems((items) => items.filter((it) => !drop.has(it.id)));
  set({ selection: get().selection.filter((id) => !drop.has(id)) });
  const { editing, lightboxId } = get();
  if (editing && drop.has(editing.itemId)) set({ editing: null });
  if (lightboxId && drop.has(lightboxId)) set({ lightboxId: null });
}

export function applyTask(task: Task) {
  const tasks = { ...get().tasks, [task.id]: task };
  let items = get().items;
  // A run can return several files; each extra one becomes its own item beside the placeholder.
  if (task.status === 'done' && task.results.length > 1) {
    const holders = items.filter((i) => i.taskId === task.id);
    const used = new Set(holders.map((h) => h.resultIndex ?? 0));
    const anchor = holders[0];
    if (anchor) {
      const extra: CanvasItem[] = [];
      let x = anchor.x + anchor.w + 24;
      task.results.forEach((asset, index) => {
        if (used.has(index)) return;
        const w = anchor.w;
        const h = Math.round(w * (asset.height / asset.width || 1));
        extra.push({ ...anchor, id: `${anchor.id}-${index}`, kind: asset.kind, x, y: anchor.y, w, h, resultIndex: index, createdAt: Date.now() });
        x += w + 24;
      });
      if (extra.length) items = [...items, ...extra];
    }
  }
  set({ tasks, items: resolveItems(items, tasks) });
}

export function setWorkflows(workflows: CustomWorkflow[], presets = get().presets) {
  set({ workflows, presets });
  // Composer pointing at a workflow that no longer exists → back to a built-in.
  const { composer } = get();
  const ids = new Set([...workflows, ...presets].map((w) => `custom:${w.id}`));
  const patch: Partial<ComposerSettings> = {};
  if (composer.imageModel.startsWith('custom:') && !ids.has(composer.imageModel)) patch.imageModel = 'qwen';
  if (composer.videoModel.startsWith('custom:') && !ids.has(composer.videoModel)) patch.videoModel = 'minimax';
  if (Object.keys(patch).length) setComposer(patch);
}

export function setComposer(patch: Partial<ComposerSettings>) {
  const composer = { ...get().composer, ...patch };
  set({ composer });
  saveComposer(composer);
}

let toastId = 0;
export function toast(text: string, tone: Toast['tone'] = 'info') {
  const id = ++toastId;
  set({ toasts: [...get().toasts, { id, text, tone }] });
  setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), tone === 'error' ? 6000 : 3000);
}

export function setViewport(v: Viewport) {
  set({ viewport: v });
}

export function zoomAt(sx: number, sy: number, zoom: number) {
  const v = get().viewport;
  const z = Math.min(8, Math.max(0.05, zoom));
  const wx = (sx - v.x) / v.zoom;
  const wy = (sy - v.y) / v.zoom;
  set({ viewport: { zoom: z, x: sx - wx * z, y: sy - wy * z } });
}

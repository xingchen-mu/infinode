import type { CanvasItem, Project } from '../shared/types';
import { fitAll } from './lib/actions';
import { ConflictError, api, clientId, type ProjectEvent } from './lib/api';
import { mergeItems } from './lib/merge';
import { applyTask, resolveItems, toast, useStore } from './store';
import { msg } from '../shared/i18n';
import { t } from './i18n';

const LAST_KEY = 'infinode:last-project';

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let loading = false;
let applyingRemote = false;

/**
 * The board as last agreed with the server. Local edits are measured against it when changes
 * made elsewhere (another tab, a script, an agent) are merged in, and its updatedAt is sent with
 * every save so a stale page cannot overwrite a newer board.
 */
let synced: { id: string; updatedAt: number; name: string; items: Map<string, string> } | null = null;

function remember(p: Pick<Project, 'id' | 'updatedAt' | 'name' | 'items'>) {
  synced = { id: p.id, updatedAt: p.updatedAt, name: p.name, items: new Map(p.items.map((i) => [i.id, JSON.stringify(i)])) };
}

/** Saves and merges run one at a time. */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 700);
}

/** Folds a newer server board into the page (and its undo history) without losing local edits. */
function mergeRemote(p: Project) {
  const s = useStore.getState();
  if (!synced || s.projectId !== p.id) return;
  const base = synced.items;
  const merge = (list: CanvasItem[]) => mergeItems(base, list, p.items);
  const items = resolveItems(merge(s.items), s.tasks);
  const projectName = s.projectName === synced.name ? p.name : s.projectName;
  remember(p);
  const ids = new Set(items.map((i) => i.id));
  applyingRemote = true;
  try {
    useStore.setState({
      items,
      projectName,
      past: s.past.map(merge),
      future: s.future.map(merge),
      selection: s.selection.filter((id) => ids.has(id)),
      ...(s.lightboxId && !ids.has(s.lightboxId) ? { lightboxId: null } : {}),
      ...(s.editing && !ids.has(s.editing.itemId) ? { editing: null } : {}),
    });
  } finally {
    applyingRemote = false;
  }
  const unchanged = items.length === p.items.length && items.every((i) => synced!.items.get(i.id) === JSON.stringify(i));
  if (!unchanged || projectName !== p.name) scheduleSave();
}

async function saveNow(keepalive: boolean) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { projectId, projectName, items, viewport } = useStore.getState();
    if (!projectId || synced?.id !== projectId) return;
    useStore.setState({ saveState: 'saving' });
    try {
      const { updatedAt } = await api.saveProject(
        projectId,
        { name: projectName, items, viewport, baseUpdatedAt: synced.updatedAt },
        keepalive,
      );
      // The page may have switched boards while this was in flight.
      if (synced?.id === projectId) remember({ id: projectId, updatedAt, name: projectName, items });
      useStore.setState({ saveState: 'saved' });
      return;
    } catch (err) {
      if (err instanceof ConflictError && !keepalive && synced?.id === projectId) {
        mergeRemote(err.project);
        continue;
      }
      useStore.setState({ saveState: 'error' });
      return;
    }
  }
  useStore.setState({ saveState: 'error' });
}

function save(keepalive = false) {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  // On unload there is no time to wait for the queue.
  return keepalive ? saveNow(true) : serial(() => saveNow(false));
}

export function flushSave() {
  if (saveTimer) void save(true);
}

/** Resolves once pending edits are on the server, e.g. before something there reads the board. */
export function savePending(): Promise<void> {
  return saveTimer ? save() : serial(async () => {});
}

export function setupAutosave() {
  return useStore.subscribe((s, prev) => {
    if (loading || applyingRemote || !s.projectId || s.projectId !== prev.projectId) return;
    if (s.items === prev.items && s.viewport === prev.viewport && s.projectName === prev.projectName) return;
    scheduleSave();
  });
}

/** After a reconnect: changes made while the event stream was down would otherwise be missed. */
export function refreshProject() {
  const id = useStore.getState().projectId;
  if (id) onProjectEvent({ id, updatedAt: Number.MAX_SAFE_INTEGER, by: 'reconnect' });
}

/** A board changed on the server; merge it in when it is the open one and someone else changed it. */
export function onProjectEvent(e: ProjectEvent) {
  if (e.id !== useStore.getState().projectId || e.by === clientId) return;
  if (e.deleted) {
    toast(t('这个画布已在别处被删除'), 'error');
    return;
  }
  void serial(async () => {
    if (!synced || synced.id !== e.id || e.updatedAt <= synced.updatedAt) return;
    try {
      const p = await api.project(e.id);
      if (p.updatedAt <= synced.updatedAt) return;
      mergeRemote(p);
    } catch {
      return;
    }
    await syncTasks(); // placeholders added elsewhere may already be finished
  });
}

/** Pulls the state of tasks that placeholders on the board are waiting for. */
export async function syncTasks() {
  const ids = [...new Set(useStore.getState().items.map((i) => i.taskId).filter((id): id is string => Boolean(id)))];
  if (!ids.length) return;
  try {
    const tasks = await api.tasks(ids);
    tasks.forEach(applyTask);
    const known = new Set(tasks.map((t) => t.id));
    // Give in-flight submissions a minute before calling them lost.
    const recent = new Set(useStore.getState().items.filter((i) => Date.now() - i.createdAt < 60_000).map((i) => i.taskId));
    const lost = ids.filter((id) => !known.has(id) && !recent.has(id));
    if (lost.length) {
      useStore.setState({
        items: useStore.getState().items.map((i) => (i.taskId && lost.includes(i.taskId) ? { ...i, error: msg('任务记录丢失，请重试') } : i)),
      });
    }
  } catch {
    /* server offline; SSE reconnect will retry */
  }
}

export async function openProject(id: string) {
  flushSave();
  loading = true;
  try {
    const p = await api.project(id);
    const { screen, tasks } = useStore.getState();
    const fresh = p.viewport.x === 0 && p.viewport.y === 0 && p.viewport.zoom === 1;
    useStore.setState({
      projectId: p.id,
      projectName: p.name,
      // Placeholders that never got a task (closed mid-submit in an older version) become retryable errors.
      items: resolveItems(
        p.items.map((i) => (i.kind !== 'text' && !i.asset && !i.taskId && !i.error ? { ...i, error: msg('提交未完成，请重试') } : i)),
        tasks,
      ),
      viewport: fresh ? { x: screen.w / 2, y: (screen.h - 160) / 2, zoom: 1 } : p.viewport,
      selection: [],
      past: [],
      future: [],
      editing: null,
      lightboxId: null,
      saveState: 'saved',
    });
    remember(p);
    localStorage.setItem(LAST_KEY, p.id);
    if (fresh && p.items.length) fitAll();
  } finally {
    loading = false;
  }
  await syncTasks();
}

export async function createProject() {
  try {
    const p = await api.createProject();
    await openProject(p.id);
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

export async function bootstrap() {
  const list = await api.projects();
  const last = localStorage.getItem(LAST_KEY);
  const id = list.find((p) => p.id === last)?.id ?? list[0]?.id;
  if (id) await openProject(id);
  else await createProject();
}

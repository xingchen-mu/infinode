import { fitAll } from './lib/actions';
import { api } from './lib/api';
import { applyTask, resolveItems, toast, useStore } from './store';

const LAST_KEY = 'comfy-canva:last-project';

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let loading = false;

async function save(keepalive = false) {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  const { projectId, projectName, items, viewport } = useStore.getState();
  if (!projectId) return;
  useStore.setState({ saveState: 'saving' });
  try {
    await api.saveProject(projectId, { name: projectName, items, viewport }, keepalive);
    useStore.setState({ saveState: 'saved' });
  } catch {
    useStore.setState({ saveState: 'error' });
  }
}

export function flushSave() {
  if (saveTimer) void save(true);
}

export function setupAutosave() {
  return useStore.subscribe((s, prev) => {
    if (loading || !s.projectId || s.projectId !== prev.projectId) return;
    if (s.items === prev.items && s.viewport === prev.viewport && s.projectName === prev.projectName) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), 700);
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
        items: useStore.getState().items.map((i) => (i.taskId && lost.includes(i.taskId) ? { ...i, error: '任务记录丢失，请重试' } : i)),
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
        p.items.map((i) => (!i.asset && !i.taskId && !i.error ? { ...i, error: '提交未完成，请重试' } : i)),
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

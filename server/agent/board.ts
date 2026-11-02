import { nanoid } from 'nanoid';
import type { AssetInfo, CanvasItem, Capabilities, MediaKind, Project, Task, TaskRequest, WorkflowLike } from '../../shared/types.ts';
import { GAP, boundsOf, displaySize, placeRow } from '../../src/lib/geometry.ts';
import type { AssetStore } from '../assets.ts';
import type { ItemsPatch, ProjectStore } from '../projects.ts';
import type { TaskManager } from '../tasks.ts';
import { featureKey } from '../workflows/index.ts';

/** What the agent needs from the server. */
export interface CanvasDeps {
  projects: ProjectStore;
  tasks: TaskManager;
  assets: AssetStore;
  /** Imported workflows and official presets. */
  workflows: () => WorkflowLike[];
  capabilities: () => Promise<Capabilities>;
  /** Tells open pages that a board changed. */
  changed: (project: Project) => void;
}

/** Same long sides the page uses, so agent results look like the user's own. */
const LONG_SIDE: Record<MediaKind, number> = { image: 512, video: 640 };

export async function readBoard(deps: CanvasDeps, projectId: string): Promise<Project> {
  const p = await deps.projects.get(projectId);
  if (!p) throw new Error('画布不存在（可能已被删除）');
  return p;
}

export async function patchBoard(deps: CanvasDeps, projectId: string, patch: ItemsPatch) {
  const p = await deps.projects.patchItems(projectId, patch);
  if (!p) throw new Error('画布不存在（可能已被删除）');
  deps.changed(p);
  return p;
}

function taskOf(deps: CanvasDeps, item: CanvasItem): Task | undefined {
  return item.taskId ? deps.tasks.list([item.taskId])[0] : undefined;
}

/** The media an item shows, including results the page has not written back yet. */
export function mediaOf(deps: CanvasDeps, item: CanvasItem): AssetInfo | undefined {
  if (item.asset) return item.asset;
  const task = taskOf(deps, item);
  if (task?.status !== 'done') return undefined;
  return task.results[item.resultIndex ?? 0] ?? task.results[0];
}

export type ItemState = { done: true; media: AssetInfo } | { done: false; finished: boolean; text: string };

/** Whether an item has its media, is still being made, or failed. */
export function stateOf(deps: CanvasDeps, item: CanvasItem): ItemState {
  const media = mediaOf(deps, item);
  if (media) return { done: true, media };
  if (item.error) return { done: false, finished: true, text: `失败：${item.error}` };
  const task = taskOf(deps, item);
  if (!task) return { done: false, finished: true, text: item.taskId ? '任务记录丢失' : '没有内容' };
  switch (task.status) {
    case 'error':
      return { done: false, finished: true, text: `失败：${task.error ?? '生成失败'}` };
    case 'cancelled':
      return { done: false, finished: true, text: '已取消' };
    case 'queued':
      return { done: false, finished: false, text: task.stage ?? '排队中' };
    default:
      return { done: false, finished: false, text: `生成中 ${Math.round(task.progress * 100)}%${task.stage ? `（${task.stage}）` : ''}` };
  }
}

function clip(s: string, max: number) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** One line per item for the model: id, kind, name, state, links and prompt. */
export function describeItem(deps: CanvasDeps, item: CanvasItem, promptChars = 80): string {
  const state = stateOf(deps, item);
  const parts = [`\`${item.id}\` ${item.kind === 'video' ? '视频' : '图片'}`];
  if (item.name) parts.push(`「${clip(item.name, 40)}」`);
  parts.push(state.done ? `${state.media.width}×${state.media.height}` : state.text);
  const inputs = item.inputs ?? (item.sourceId ? [item.sourceId] : []);
  if (inputs.length) parts.push(`由 ${inputs.map((id) => `\`${id}\``).join(' ')} 生成`);
  const prompt = item.request && 'prompt' in item.request ? item.request.prompt : undefined;
  if (prompt) parts.push(`提示词：${clip(prompt, promptChars)}`);
  return parts.join(' · ');
}

/** Board items by id, in the order given; unknown ids are an error the model can act on. */
export function findItems(project: Project, ids: string[]): CanvasItem[] {
  return ids.map((id) => {
    const item = project.items.find((i) => i.id === id);
    if (!item) throw new Error(`画布上没有 id 为 ${id} 的节点（用 read_board 查看现有节点）`);
    return item;
  });
}

/** Items used as inputs: they must be finished and of the right kind. */
export function inputMedia(deps: CanvasDeps, items: CanvasItem[], kind: MediaKind): AssetInfo[] {
  return items.map((item) => {
    const state = stateOf(deps, item);
    if (!state.done) {
      throw new Error(
        state.finished ? `节点 ${item.id} 没有可用的结果（${state.text}）` : `节点 ${item.id} 还在生成（${state.text}），用 wait_for_items 等它完成再用`,
      );
    }
    if (state.media.kind !== kind) throw new Error(`节点 ${item.id} 是${state.media.kind === 'video' ? '视频' : '图片'}，这里需要${kind === 'video' ? '视频' : '图片'}`);
    return state.media;
  });
}

/** Fails early, with a reason, when the server cannot run a request. */
export async function ensureRunnable(deps: CanvasDeps, request: TaskRequest) {
  const caps = await deps.capabilities();
  if (!caps.comfyOnline) throw new Error('现在连不上 ComfyUI，等它恢复后再试');
  const missing = caps.features[featureKey(request)] ?? [];
  if (missing.length) throw new Error(`ComfyUI 服务器缺少：${missing.join('、')}`);
}

/**
 * Queues `count` runs of a request and puts a placeholder for each on the board, beside its first
 * input (or where the user was looking), linked to its inputs. The page fills them in as they finish.
 */
export async function launch(
  deps: CanvasDeps,
  writer: ResultWriter,
  projectId: string,
  opts: { request: TaskRequest; count: number; inputs: CanvasItem[]; name?: string; view?: { x: number; y: number } },
): Promise<{ items: CanvasItem[]; error?: string }> {
  await ensureRunnable(deps, opts.request);
  const tasks: Task[] = [];
  let error: string | undefined;
  for (let i = 0; i < opts.count; i++) {
    try {
      tasks.push(await deps.tasks.create(opts.request));
    } catch (err) {
      // Keep what was already queued on the board; report the rest.
      if (!tasks.length) throw err;
      error = (err as Error).message;
      break;
    }
  }
  const project = await readBoard(deps, projectId);
  const sizes = tasks.map((t) => displaySize(t.expected.width, t.expected.height, LONG_SIDE[t.expected.kind]));
  const rowW = sizes.reduce((s, r) => s + r.w, 0) + GAP * (sizes.length - 1);
  const anchor = opts.inputs[0];
  const bounds = boundsOf(project.items);
  const start = anchor
    ? { x: anchor.x + anchor.w + GAP * 3, y: anchor.y + (anchor.h - sizes[0].h) / 2 }
    : opts.view
      ? { x: opts.view.x - rowW / 2, y: opts.view.y - sizes[0].h / 2 }
      : bounds
        ? { x: bounds.x + bounds.w + GAP * 3, y: bounds.y }
        : { x: 0, y: 0 };
  const positions = placeRow(project.items, start, sizes);
  const now = Date.now();
  const items: CanvasItem[] = tasks.map((task, i) => ({
    id: nanoid(10),
    kind: task.expected.kind,
    x: Math.round(positions[i].x),
    y: Math.round(positions[i].y),
    w: sizes[i].w,
    h: sizes[i].h,
    taskId: task.id,
    resultIndex: 0,
    request: opts.request,
    inputs: opts.inputs.length ? opts.inputs.map((i) => i.id) : undefined,
    name: opts.name?.trim().slice(0, 60) || undefined,
    createdAt: now,
  }));
  await patchBoard(deps, projectId, { upsert: items });
  writer.track(projectId, items);
  return { items, error };
}

/** A placeholder with its finished task's result (or error) filled in, as the page does it. */
function resolved(item: CanvasItem, task: Task): CanvasItem {
  if (task.status !== 'done') return { ...item, error: task.status === 'cancelled' ? '已取消' : (task.error ?? '生成失败') };
  const asset = task.results[item.resultIndex ?? 0] ?? task.results[0];
  if (!asset) return { ...item, taskId: undefined, error: '没有返回结果' };
  const h = Math.round(item.w / (asset.width / asset.height));
  return { ...item, kind: asset.kind, taskId: undefined, error: undefined, asset, h, y: Math.round(item.y + (item.h - h) / 2) };
}

/** Writes results into the agent's placeholders, so boards stay right when no page is open. */
export class ResultWriter {
  private waiting = new Map<string, { projectId: string; itemId: string }>();

  constructor(private deps: CanvasDeps) {
    deps.tasks.on('task', (t: Task) => void this.onTask(t));
  }

  track(projectId: string, items: CanvasItem[]) {
    for (const i of items) if (i.taskId) this.waiting.set(i.taskId, { projectId, itemId: i.id });
  }

  private async onTask(task: Task) {
    const w = this.waiting.get(task.id);
    if (!w || task.status === 'queued' || task.status === 'running') return;
    this.waiting.delete(task.id);
    try {
      const p = await this.deps.projects.get(w.projectId);
      const item = p?.items.find((i) => i.id === w.itemId);
      // Gone, or the page already filled it in.
      if (!item || item.taskId !== task.id || item.asset) return;
      await patchBoard(this.deps, w.projectId, { upsert: [resolved(item, task)] });
    } catch (err) {
      console.error('agent: could not write a result to the board', err);
    }
  }
}

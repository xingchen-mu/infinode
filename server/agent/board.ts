import { nanoid } from 'nanoid';
import type { AssetInfo, CanvasItem, Capabilities, MediaKind, Project, Task, TaskRequest, WorkflowLike } from '../../shared/types.ts';
import { GAP, type Rect, boundsOf, displaySize, intersects, placeRow } from '../../shared/geometry.ts';
import type { AssetStore } from '../assets/store.ts';
import type { ItemsPatch, ProjectStore } from '../projects/store.ts';
import type { TaskManager } from '../tasks/manager.ts';
import { msg } from '../../shared/i18n.ts';
import { blockReason, isBlock } from '../../shared/licenses.ts';
import { featureKey } from '../workflows/index.ts';
import { list, t } from '../i18n.ts';

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
  /** The user only wants models whose license allows commercial use. */
  commercialOnly?: () => boolean;
}

/** Same long sides the page uses, so agent results look like the user's own. */
export const LONG_SIDE: Record<MediaKind, number> = { image: 512, video: 640 };

export async function readBoard(deps: CanvasDeps, projectId: string): Promise<Project> {
  const p = await deps.projects.get(projectId);
  if (!p) throw new Error(t('画布不存在（可能已被删除）'));
  return p;
}

export async function patchBoard(deps: CanvasDeps, projectId: string, patch: ItemsPatch) {
  const p = await deps.projects.patchItems(projectId, patch);
  if (!p) throw new Error(t('画布不存在（可能已被删除）'));
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

/** One line per item for the model: id, kind, name, state, links and prompt (or a note's text). */
export function describeItem(deps: CanvasDeps, item: CanvasItem, promptChars = 80): string {
  if (item.kind === 'text') {
    const text = item.text?.trim() ?? '';
    return [`\`${item.id}\` 文本`, item.name ? `「${clip(item.name, 40)}」` : '', text ? `内容：${promptChars > 1000 ? text : clip(text, promptChars)}` : '（空）']
      .filter(Boolean)
      .join(' · ');
  }
  const state = stateOf(deps, item);
  const parts = [`\`${item.id}\` ${item.kind === 'video' ? '视频' : '图片'}`];
  if (item.name) parts.push(`「${clip(item.name, 40)}」`);
  if (item.group) parts.push(`类型：${item.group}`);
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
    if (!item) throw new Error(t('画布上没有 id 为 {id} 的节点（用 read_board 查看现有节点）', { id }));
    return item;
  });
}

/** Items used as inputs: they must be finished and of the right kind. */
export function inputMedia(deps: CanvasDeps, items: CanvasItem[], kind: MediaKind): AssetInfo[] {
  return items.map((item) => {
    const state = stateOf(deps, item);
    if (!state.done) {
      throw new Error(
        state.finished
          ? t('节点 {id} 没有可用的结果（{state}）', { id: item.id, state: state.text })
          : t('节点 {id} 还在生成（{state}），用 wait_for_items 等它完成再用', { id: item.id, state: state.text }),
      );
    }
    if (state.media.kind !== kind) throw new Error(kind === 'video' ? t('节点 {id} 是图片，这里需要视频', { id: item.id }) : t('节点 {id} 是视频，这里需要图片', { id: item.id }));
    return state.media;
  });
}

/** Fails early, with a reason, when the server cannot run a request. */
export async function ensureRunnable(deps: CanvasDeps, request: TaskRequest) {
  const caps = await deps.capabilities();
  if (!caps.comfyOnline) throw new Error(t('现在连不上 ComfyUI，等它恢复后再试'));
  const missing = caps.features[featureKey(request)] ?? [];
  const blocked = missing.filter(isBlock).map((m) => blockReason(m, t));
  if (blocked.length) throw new Error(t('用户开启了「只用可商用的模型」，这个工具不能用：{reasons}。换用可商用的模型或模板（list_workflows 里有标注）', { reasons: blocked.join('; ') }));
  if (missing.length) throw new Error(t('ComfyUI 服务器缺少：{list}', { list: list(missing) }));
}

export interface BatchJob {
  request: TaskRequest;
  /** Board items used as inputs, in request order (drawn as links). */
  inputs: CanvasItem[];
  name?: string;
  /** Image type (layout 'groups'): jobs of one type stack in one column. */
  group?: string;
  /** Placeholder size; by default from the output size. */
  size?: { w: number; h: number };
}

/**
 * How a batch is placed: `row` / `column` as one block (beside the first job's first input, else where
 * the user looks), `beside`: each placeholder right of its own first input (e.g. a video beside its frame),
 * `groups`: one column per image type (see placeGroups).
 */
export type BatchLayout = 'row' | 'column' | 'beside' | 'groups';

type Size = { w: number; h: number };
type Point = { x: number; y: number };

/** A column of `sizes` at `start.x`, moved down past anything in the way. */
function stackDown(taken: Rect[], start: Point, sizes: Size[]): Point[] {
  const w = Math.max(...sizes.map((s) => s.w));
  const h = sizes.reduce((n, s) => n + s.h, 0) + GAP * (sizes.length - 1);
  let y = start.y;
  for (let tries = 0; tries < 100; tries++) {
    const hits = taken.filter((r) => intersects({ x: start.x, y, w, h }, r, GAP / 2));
    if (!hits.length) break;
    y = Math.max(...hits.map((r) => r.y + r.h)) + GAP;
  }
  return sizes.map((s) => {
    const p = { x: start.x, y };
    y += s.h + GAP;
    return p;
  });
}

/**
 * One column per image type, top to bottom in job order. A type that already has a column on the board
 * continues below its lowest item; new types become columns side by side, beside the first job's first input
 * (else `fallback`). Jobs without a type share one new column.
 */
export function placeGroups(items: CanvasItem[], jobs: Pick<BatchJob, 'group' | 'inputs'>[], sizes: Size[], fallback: (w: number, h: number) => Point): Point[] {
  const positions: Point[] = [];
  const taken: Rect[] = [...items];
  const columns = new Map<string, number[]>();
  jobs.forEach((job, i) => {
    const key = job.group?.trim() ?? '';
    columns.set(key, [...(columns.get(key) ?? []), i]);
  });
  const fresh: number[][] = [];
  for (const [key, idx] of columns) {
    const existing = key ? items.filter((it) => it.group === key) : [];
    if (!existing.length) {
      fresh.push(idx);
      continue;
    }
    const last = existing.reduce((a, b) => (b.y + b.h > a.y + a.h ? b : a));
    stackDown(taken, { x: last.x, y: last.y + last.h + GAP }, idx.map((i) => sizes[i])).forEach((p, n) => {
      positions[idx[n]] = p;
      taken.push({ ...p, ...sizes[idx[n]] });
    });
  }
  if (fresh.length) {
    const widths = fresh.map((idx) => Math.max(...idx.map((i) => sizes[i].w)));
    const heights = fresh.map((idx) => idx.reduce((n, i) => n + sizes[i].h, 0) + GAP * (idx.length - 1));
    const block = { w: widths.reduce((a, b) => a + b, 0) + GAP * 2 * (fresh.length - 1), h: Math.max(...heights) };
    const a = jobs[fresh[0][0]].inputs[0];
    const start = a ? { x: a.x + a.w + GAP * 3, y: a.y } : fallback(block.w, block.h);
    const [origin] = placeRow(taken as CanvasItem[], start, [block]);
    let x = origin.x;
    fresh.forEach((idx, k) => {
      let y = origin.y;
      for (const i of idx) {
        positions[i] = { x, y };
        y += sizes[i].h + GAP;
      }
      x += widths[k] + GAP * 2;
    });
  }
  return positions;
}

/**
 * Queues each job and puts a placeholder for it on the board, linked to its inputs. The page fills
 * them in as they finish. Jobs that fail to queue are reported, not placed.
 */
export async function launchBatch(
  deps: CanvasDeps,
  writer: ResultWriter,
  projectId: string,
  jobs: BatchJob[],
  opts: { layout: BatchLayout; view?: { x: number; y: number } },
): Promise<{ items: CanvasItem[]; failed: { index: number; error: string }[] }> {
  for (const key of new Set(jobs.map((j) => featureKey(j.request)))) await ensureRunnable(deps, jobs.find((j) => featureKey(j.request) === key)!.request);
  const created: { job: BatchJob; task: Task }[] = [];
  const failed: { index: number; error: string }[] = [];
  for (const [index, job] of jobs.entries()) {
    try {
      created.push({ job, task: await deps.tasks.create(job.request) });
    } catch (err) {
      failed.push({ index, error: (err as Error).message });
    }
  }
  if (!created.length) return { items: [], failed };

  const project = await readBoard(deps, projectId);
  const sizes = created.map(({ job, task }) => job.size ?? displaySize(task.expected.width, task.expected.height, LONG_SIDE[task.expected.kind]));
  const bounds = boundsOf(project.items);
  const fallback = (w: number, h: number) =>
    opts.view ? { x: opts.view.x - w / 2, y: opts.view.y - h / 2 } : bounds ? { x: bounds.x + bounds.w + GAP * 3, y: bounds.y } : { x: 0, y: 0 };
  let positions: { x: number; y: number }[];
  if (opts.layout === 'groups') {
    positions = placeGroups(project.items, created.map(({ job }) => job), sizes, fallback);
  } else if (opts.layout === 'beside') {
    const taken: Rect[] = [...project.items];
    positions = created.map(({ job }, i) => {
      const a = job.inputs[0];
      const start = a ? { x: a.x + a.w + GAP * 3, y: a.y + (a.h - sizes[i].h) / 2 } : fallback(sizes[i].w, sizes[i].h);
      const [p] = placeRow(taken as CanvasItem[], start, [sizes[i]]);
      taken.push({ ...p, ...sizes[i] });
      return p;
    });
  } else {
    const row = opts.layout === 'row';
    const blockW = row ? sizes.reduce((n, r) => n + r.w, 0) + GAP * (sizes.length - 1) : Math.max(...sizes.map((r) => r.w));
    const blockH = row ? Math.max(...sizes.map((r) => r.h)) : sizes.reduce((n, r) => n + r.h, 0) + GAP * (sizes.length - 1);
    const a = created[0].job.inputs[0];
    const start = a ? { x: a.x + a.w + GAP * 3, y: row ? a.y + (a.h - blockH) / 2 : a.y } : fallback(blockW, blockH);
    const [origin] = placeRow(project.items, start, [{ w: blockW, h: blockH }]);
    let offset = 0;
    positions = sizes.map((r) => {
      const p = row ? { x: origin.x + offset, y: origin.y + (blockH - r.h) / 2 } : { x: origin.x, y: origin.y + offset };
      offset += (row ? r.w : r.h) + GAP;
      return p;
    });
  }

  const now = Date.now();
  const items: CanvasItem[] = created.map(({ job, task }, i) => ({
    id: nanoid(10),
    kind: task.expected.kind,
    x: Math.round(positions[i].x),
    y: Math.round(positions[i].y),
    w: Math.round(sizes[i].w),
    h: Math.round(sizes[i].h),
    taskId: task.id,
    resultIndex: 0,
    request: job.request,
    inputs: job.inputs.length ? job.inputs.map((it) => it.id) : undefined,
    name: job.name?.trim().slice(0, 60) || undefined,
    group: job.group?.trim().slice(0, 30) || undefined,
    createdAt: now,
  }));
  await patchBoard(deps, projectId, { upsert: items });
  writer.track(projectId, items);
  return { items, failed };
}

/**
 * `count` runs of one request beside its first input: images in their type's column (one new column when
 * no type is given), other results side by side.
 */
export async function launch(
  deps: CanvasDeps,
  writer: ResultWriter,
  projectId: string,
  opts: { request: TaskRequest; count: number; inputs: CanvasItem[]; name?: string; group?: string; images?: boolean; view?: { x: number; y: number } },
): Promise<{ items: CanvasItem[]; error?: string }> {
  const jobs = Array.from({ length: opts.count }, () => ({ request: opts.request, inputs: opts.inputs, name: opts.name, group: opts.group }));
  const { items, failed } = await launchBatch(deps, writer, projectId, jobs, { layout: opts.images ? 'groups' : 'row', view: opts.view });
  if (!items.length) throw new Error(failed[0]?.error ?? t('提交失败'));
  return { items, error: failed[0]?.error };
}

/** A placeholder with its finished task's result (or error) filled in, as the page does it. */
function resolved(item: CanvasItem, task: Task): CanvasItem {
  if (task.status !== 'done') return { ...item, error: task.status === 'cancelled' ? msg('已取消') : (task.error ?? msg('生成失败')) };
  const asset = task.results[item.resultIndex ?? 0] ?? task.results[0];
  if (!asset) return { ...item, taskId: undefined, error: msg('没有返回结果') };
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

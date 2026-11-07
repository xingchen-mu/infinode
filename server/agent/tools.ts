import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { msg } from '../../shared/i18n.ts';
import { licenseLabel } from '../../shared/licenses.ts';
import { list, t } from '../i18n.ts';
import type { CanvasItem, ImageModel, Task, TaskRequest, VideoModel, WorkflowInput, WorkflowLike } from '../../shared/types.ts';
import { GAP, boundsOf, displaySize, placeRow } from '../../shared/geometry.ts';
import { publicAsset } from '../assets/store.ts';
import {
  type BatchJob,
  type CanvasDeps,
  type ResultWriter,
  describeItem,
  findItems,
  inputMedia,
  launch,
  launchBatch,
  patchBoard,
  readBoard,
  stateOf,
} from './board.ts';
import { imageEstimate, roughly, videoEstimate } from './estimate.ts';
import { GUIDES } from './guides.ts';
import { redoneVersion } from '../../shared/frames.ts';
import { type Arrangement, type Side, arrange, besideOf, clearOf } from './layout.ts';
import { type Tile, concatClips, contactSheet, probe, soundSpans, videoFrame } from './media.ts';

/** Per call: which board, and where the user was looking when they asked. */
export interface ToolContext {
  projectId: string;
  /** Board point at the center of the user's view; new unlinked items go there. */
  view?: { x: number; y: number };
  signal?: AbortSignal;
  /** Fires when the user sends another message during the run; long waits end early so it is read. */
  interrupt?: AbortSignal;
  /** Short progress line for the panel while the call runs. */
  progress?: (text: string) => void;
  /** Wake the agent with a summary once all these tasks have finished. */
  notify?: (what: string, items: CanvasItem[]) => void;
  /** The agent already knows how these items ended (it waited or cancelled): no notice about them. */
  seen?: (ids: string[]) => void;
}

export interface ToolOutput {
  /** What the model reads. */
  text: string;
  images?: { data: string; mimeType: string }[];
  /** One line for the panel. */
  summary: string;
  /** Board items to show with the call. */
  items?: string[];
  /**
   * Hold the work until the user agrees in the panel; then `approve(payload)` runs it. `frames`: first
   * frames (or other items) the card shows; `since`: when it was made, so frames redone later replace them;
   * `confirm`: the button's label, when not 开始.
   */
  approval?: { title: string; detail: string; payload: Json; frames?: string[]; since?: number; confirm?: string };
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A canvas operation, independent of the agent runtime (plain JSON Schema parameters). */
export interface CanvasTool<A = Record<string, unknown>> {
  name: string;
  /** Short name for the panel (Chinese source text, shown through t). */
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Only offered to models that can see images. */
  vision?: boolean;
  /** Changes nothing (outside agents may run these without asking). */
  readOnly?: boolean;
  /** Cancels or removes things. */
  destructive?: boolean;
  /** What a call is doing, from its arguments. */
  describe(args: A): string;
  run(args: A, ctx: ToolContext): Promise<ToolOutput>;
  /** Does the work `run` asked approval for. */
  approve?(payload: Json, ctx: ToolContext): Promise<ToolOutput>;
}

const tool = <A>(def: CanvasTool<A>) => def as unknown as CanvasTool;

const ids = (description: string, max?: number) => ({
  type: 'array',
  items: { type: 'string' },
  description,
  ...(max ? { maxItems: max } : {}),
});

const clip = (s: string, max = 40) => (s.length > max ? `${s.slice(0, max)}…` : s);

const VIDEO_DURATIONS = [3, 5, 8, 10];
const snapDuration = (s: number | undefined) => VIDEO_DURATIONS.reduce((best, d) => (Math.abs(d - (Number(s) || 5)) < Math.abs(best - (Number(s) || 5)) ? d : best));
const MAX_BATCH = 40;
const MAX_LISTED = 300;
const VIEWABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);
/** Videos review_items looks at in one call (three frames each). */
const MAX_REVIEW_CLIPS = 8;
/** Moved items whose old positions a result lists, so the model can put them back. */
const MAX_RESTORE = 100;
const SIDES: Side[] = ['right', 'left', 'below', 'above'];
const ARRANGEMENTS: Arrangement[] = ['row', 'column', 'grid', 'groups'];
const ARRANGED: Record<Arrangement, string> = { row: '一行', column: '一列', grid: '网格', groups: '按类型分列' };

/** Where an item sits on the board and how large it is shown there. */
const placed = (i: CanvasItem) => ` · 在画布 (${i.x},${i.y})，显示 ${i.w}×${i.h}`;

/** The board cannot undo what the assistant moved: the result lists where things were. */
const formerly = (items: CanvasItem[]) =>
  items.length > MAX_RESTORE
    ? `（共 ${items.length} 个，太多了，没有记下原位置）`
    : `原位置（用户要放回去时，用 move_items 的 positions 照这些坐标放回）：${items.map((i) => `\`${i.id}\` (${i.x},${i.y})`).join('，')}`;

const chunk = <T,>(xs: T[], size: number): T[][] => Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size));

/** Generation settings of an item, without the prompt and asset ids. */
function settingsOf(req: TaskRequest | undefined): string {
  if (!req) return '';
  const { prompt: _p, images: _i, videos: _v, ...rest } = req as Record<string, unknown>;
  return ` · 参数：${JSON.stringify(rest)}`;
}

function inputsLine(wf: WorkflowLike): string {
  const describe = (i: WorkflowInput) => {
    const opt = i.optional ? '（可选）' : '';
    switch (i.type) {
      case 'prompt':
        return `提示词${i.default ? '（有默认值）' : ''}`;
      case 'negative':
        return '反向提示词';
      case 'image':
        return `图片「${i.label}」${opt}`;
      case 'video':
        return `视频「${i.label}」${opt}`;
      case 'mask':
        return '蒙版';
      case 'width':
      case 'height':
      case 'aspect':
        return '画面尺寸（用 aspect 参数）';
      case 'seed':
        return '';
      default: {
        const extra = [i.options?.length ? `可选值 ${i.options.join(' / ')}` : '', i.default !== undefined ? `默认 ${String(i.default)}` : '']
          .filter(Boolean)
          .join('，');
        return `params.${i.id}「${i.label}」(${i.type}${extra ? `，${extra}` : ''})`;
      }
    }
  };
  return [...new Set(wf.inputs.map(describe).filter(Boolean))].join('；') || '无';
}

/**
 * `panel`: the in-app assistant, which is woken when batches finish and asks for approval in the panel.
 * `mcp`: an outside agent (Claude Code, Codex…), which waits with wait_for_items and asks its user itself.
 */
export type ToolHost = 'panel' | 'mcp';

export function canvasTools(deps: CanvasDeps, writer: ResultWriter, host: ToolHost = 'panel'): CanvasTool[] {
  const afterBatch = host === 'panel' ? '这一批全部结束时你会自动收到一条通知，不用 wait_for_items。' : '用 wait_for_items 等结果（单次等待有上限，超时就再调用一次）。';

  const commercial = () => Boolean(deps.commercialOnly?.());
  /** Qwen-Image 2.1 unless asked otherwise, or Z-Image when only commercially licensed models may run. */
  const imageModel = (asked?: ImageModel): ImageModel => (asked === 'zimage' || asked === 'qwen' ? asked : commercial() ? 'zimage' : 'qwen');
  const noReferences = () =>
    commercial()
      ? t('zimage 不支持参考图；用户开启了「只用可商用的模型」，Qwen-Image 2.1 也不能用。改图请用 list_workflows 里可商用的模板（如 Qwen-Image-Edit 2511），通过 run_workflow 运行')
      : t('zimage 不支持参考图，要用参考图请用 qwen');

  const launchVideos = async (payload: Json, ctx: ToolContext): Promise<ToolOutput> => {
    const { quality, jobs, since } = payload as { quality: '480p' | '720p'; jobs: { prompt: string; frames: string[]; duration: number; name: string | null }[]; since?: number };
    const p = await readBoard(deps, ctx.projectId);
    const redone: string[] = [];
    const batch: BatchJob[] = jobs.map((j) => {
      const frames = findItems(p, j.frames).map((f) => {
        const newer = since ? redoneVersion(p.items, f, since, (i) => stateOf(deps, i).done) : undefined;
        if (newer) redone.push(`${f.name}：\`${f.id}\` → \`${newer.id}\``);
        return newer ?? f;
      });
      const media = inputMedia(deps, frames, 'image');
      const first = frames[0];
      return {
        request: { op: 'video.generate', model: 'minimax', prompt: j.prompt, aspect: 'auto', quality, duration: j.duration, images: media.map((m) => m.id) },
        inputs: frames,
        name: j.name ?? undefined,
        // Same height as its frame, so the storyboard keeps one row per shot.
        size: { w: Math.round(first.h * (media[0].width / media[0].height)), h: first.h },
      };
    });
    const { items, failed } = await launchBatch(deps, writer, ctx.projectId, batch, { layout: 'beside', view: ctx.view });
    if (!items.length) throw new Error(failed[0]?.error ?? t('提交失败'));
    ctx.notify?.(host === 'panel' ? t('用户确认后提交的 {n} 段视频', { n: items.length }) : t('{n} 段视频', { n: items.length }), items);
    return {
      text:
        `已提交 ${items.length} 段视频：${items.map((i) => `${i.name ? `${i.name} → ` : ''}\`${i.id}\``).join('，')}` +
        (redone.length ? `\n确认卡之后重做过的首帧，用了重做后的版本：${redone.join('；')}` : '') +
        (ctx.notify ? '' : `\n${afterBatch}`),
      summary: failed.length
        ? t('{n} 段已提交，{failed} 段失败：{error}', { n: items.length, failed: failed.length, error: failed[0].error })
        : redone.length
          ? t('{n} 段已提交，其中 {redone} 段用了重做后的首帧', { n: items.length, redone: redone.length })
          : t('{n} 段已提交', { n: items.length }),
      items: items.map((i) => i.id),
    };
  };

  /** Takes finished items off the board; their files stay in the asset library. */
  const deleteItems = async (payload: Json, ctx: ToolContext): Promise<ToolOutput> => {
    const { ids: doomed } = payload as { ids: string[] };
    const p = await readBoard(deps, ctx.projectId);
    const present = doomed.filter((id) => p.items.some((i) => i.id === id));
    if (present.length) await patchBoard(deps, ctx.projectId, { remove: present });
    const gone = doomed.length - present.length;
    return {
      text:
        `已从画布删掉 ${present.length} 个节点：${present.map((id) => `\`${id}\``).join(' ')}` +
        (gone ? `（另有 ${gone} 个在确认前已经不在画布上了）` : '') +
        '。文件还在资产库里，用户可以从那里加回画布。',
      summary: t('删掉了 {n} 个', { n: present.length }),
    };
  };

  return [
    tool<{ ids?: string[] }>({
      name: 'read_board',
      readOnly: true,
      label: msg('读取画布'),
      description:
        '列出画布上的节点：id、图片还是视频、名称、尺寸或生成状态、由哪些节点生成、提示词，以及在画布上的位置（左上角坐标，x 向右、y 向下）和显示大小。传 ids 时只看这些节点，给出完整提示词和生成参数。',
      parameters: { type: 'object', properties: { ids: ids('只看这些节点（可选）') } },
      describe: (a) => (a.ids?.length ? t('{n} 个节点', { n: a.ids.length }) : t('全部节点')),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        if (args.ids?.length) {
          const items = findItems(p, args.ids);
          return {
            text: items.map((i) => describeItem(deps, i, 4000) + placed(i) + settingsOf(i.request)).join('\n'),
            summary: t('{n} 个节点', { n: items.length }),
            items: items.map((i) => i.id),
          };
        }
        const shown = p.items.slice(-MAX_LISTED);
        const lines = shown.map((i) => `- ${describeItem(deps, i)}${placed(i)}`);
        const more = p.items.length > shown.length ? `\n（只列出了最新的 ${shown.length} 个）` : '';
        return {
          text: p.items.length ? `画布「${p.name}」共 ${p.items.length} 个节点：\n${lines.join('\n')}${more}` : `画布「${p.name}」是空的`,
          summary: t('{n} 个节点', { n: p.items.length }),
        };
      },
    }),

    tool<{ name: string; section?: string }>({
      name: 'read_guide',
      readOnly: true,
      label: msg('读手册'),
      description:
        '读做某类作品的手册：步骤、规则、自查清单和例子。开始做之前先读全文（不传 section）；之后哪一步的规则记不清了，就只重读那一节，不要凭印象做。现有的手册：' +
        GUIDES.map((g) => `${g.id}（${g.when}；分节：${g.sections.map((s) => s.id).join('、')}）`).join('；'),
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: GUIDES.map((g) => g.id) },
          section: { type: 'string', enum: [...new Set(GUIDES.flatMap((g) => g.sections.map((s) => s.id)))], description: '只读这一节；不传就读全文' },
        },
        required: ['name'],
      },
      describe: (a) => {
        const g = GUIDES.find((x) => x.id === a.name);
        const s = g?.sections.find((x) => x.id === a.section);
        return g ? (s ? t('{guide} · {section}', { guide: t(g.title), section: t(s.title) }) : t(g.title)) : (a.name ?? '');
      },
      async run(args) {
        const g = GUIDES.find((x) => x.id === args.name);
        if (!g) throw new Error(`没有叫 ${args.name} 的手册，现有：${GUIDES.map((x) => x.id).join('、')}`);
        const sections = args.section ? g.sections.filter((s) => s.id === args.section) : g.sections;
        if (!sections.length) throw new Error(`${g.id} 手册里没有 ${args.section} 这一节，现有：${g.sections.map((s) => s.id).join('、')}`);
        return {
          text: sections.map((s) => s.text).join('\n\n'),
          summary: sections.length === 1 ? t('{guide} · {section}', { guide: t(g.title), section: t(sections[0].title) }) : t(g.title),
        };
      },
    }),

    tool<{ ids: string[] }>({
      name: 'view_images',
      readOnly: true,
      label: msg('查看图片'),
      vision: true,
      description: '查看画布上的图片节点（一次最多 4 张），用来检查生成质量或看懂参考图。视频看不了，可以看它的首帧或参考图。',
      parameters: { type: 'object', properties: { ids: { ...ids('图片节点 id', 4), minItems: 1 } }, required: ['ids'] },
      describe: (a) => t('{n} 张', { n: a.ids?.length ?? 0 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const items = findItems(p, args.ids.slice(0, 4));
        const images: ToolOutput['images'] = [];
        const lines: string[] = [];
        for (const item of items) {
          const state = stateOf(deps, item);
          if (!state.done) {
            lines.push(`\`${item.id}\`：${state.text}，还没有图可看`);
            continue;
          }
          const stored = deps.assets.get(state.media.id);
          if (state.media.kind !== 'image' || !stored || !VIEWABLE.has(stored.mime)) {
            lines.push(`\`${item.id}\`：${state.media.kind === 'video' ? '是视频，看不了' : '文件格式看不了'}`);
            continue;
          }
          images.push({ data: (await deps.assets.read(stored)).toString('base64'), mimeType: stored.mime });
          lines.push(`第 ${images.length} 张：${describeItem(deps, item, 200)}`);
        }
        return { text: lines.join('\n'), images, summary: t('{n} 张图片', { n: images.length }), items: items.map((i) => i.id) };
      },
    }),

    tool<{ prompt: string; model?: ImageModel; reference_ids?: string[]; aspect?: string; quality?: '1k' | '2k'; count?: number; name?: string; group?: string }>({
      name: 'generate_image',
      label: msg('生成图片'),
      description:
        '在画布上生成图片，结果放在第一张参考图旁边并连线（多张从上到下排成一列；写了 group 时排进那一类型的列）。提交后立刻返回新节点 id，不等结果。' +
        'qwen（默认，Qwen-Image）：质量高、能写中文字，可传最多 10 张参考图做编辑、换背景、保持人物一致，提示词里用「图1」「图2」按 reference_ids 的顺序指代。' +
        'zimage（Z-Image Turbo）：几秒出图的草图模型，不支持参考图。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '画面描述' },
          model: { type: 'string', enum: ['qwen', 'zimage'] },
          reference_ids: ids('参考图节点 id（只有 qwen 支持，最多 10 张）', 10),
          aspect: { type: 'string', description: '画面比例，如 16:9、9:16、1:1、3:4、4:3、21:9；auto = 跟第一张参考图一样。默认：有参考图时 auto，否则 1:1' },
          quality: { type: 'string', enum: ['1k', '2k'], description: '默认 1k' },
          count: { type: 'integer', minimum: 1, maximum: 4, description: '张数，默认 1' },
          name: { type: 'string', description: '节点名称（可选，显示在画布上）' },
          group: { type: 'string', description: '图片类型，如「全身照」「脸部特写」「场景」「关键帧」：同一类型的图从上到下排成一列，画布上已有这一列时接在它下面（可选）' },
        },
        required: ['prompt'],
      },
      describe: (a) => clip(a.prompt ?? ''),
      async run(args, ctx) {
        const model = imageModel(args.model);
        const refIds = args.reference_ids ?? [];
        if (model === 'zimage' && refIds.length) throw new Error(noReferences());
        if (refIds.length > 10) throw new Error(t('参考图最多 {n} 张', { n: 10 }));
        const p = await readBoard(deps, ctx.projectId);
        const refs = findItems(p, refIds);
        const media = inputMedia(deps, refs, 'image');
        const request: TaskRequest = {
          op: 'image.generate',
          model,
          prompt: args.prompt,
          aspect: args.aspect?.trim() || (refs.length ? 'auto' : '1:1'),
          quality: args.quality === '2k' ? '2k' : '1k',
          images: media.map((m) => m.id),
        };
        const count = Math.min(4, Math.max(1, Math.round(args.count ?? 1)));
        const { items, error } = await launch(deps, writer, ctx.projectId, { request, count, inputs: refs, name: args.name, group: args.group, images: true, view: ctx.view });
        const made = items.map((i) => `\`${i.id}\``).join(' ');
        return {
          text: `已提交 ${items.length} 张，新节点：${made}。每张${roughly(imageEstimate(deps.tasks.list(), request))}（前面有排队任务会更久）。${error ? `另有 ${count - items.length} 张提交失败：${error}` : ''}`,
          summary: t('{n} 张已提交', { n: items.length }),
          items: items.map((i) => i.id),
        };
      },
    }),

    tool<{ prompt: string; model?: VideoModel; image_ids?: string[]; aspect?: string; quality?: '480p' | '720p'; duration?: number; count?: number; name?: string }>({
      name: 'generate_video',
      label: msg('生成视频'),
      description:
        '用 MiniMax H3 在画布上生成带音频的视频，提交后立刻返回新节点 id，不等结果。很慢：一段要几分钟，具体按这台服务器的实测速度算（面板里写在 <canvas_context>，外部 agent 用 get_context 查），GPU 一次只跑一个任务。' +
        'minimax（默认）：image_ids 可传 0–2 张，第 1 张是首帧、第 2 张是尾帧，不传就是纯文生视频。' +
        'minimax-ref（多图参考）：image_ids 传 1–9 张参考图（人物、场景、道具、分镜），提示词里用 @图1、@图2 指代。' +
        '提示词写动作、镜头运动、对白和声音，不要只重复画面内容。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          model: { type: 'string', enum: ['minimax', 'minimax-ref'] },
          image_ids: ids('首帧/尾帧或参考图的节点 id', 9),
          aspect: { type: 'string', description: '16:9、9:16、1:1、4:3、3:4；auto = 跟第一张图一样。默认：有图时 auto，否则 16:9' },
          quality: { type: 'string', enum: ['480p', '720p'], description: '默认 480p，720p 更清晰也更慢' },
          duration: { type: 'integer', enum: VIDEO_DURATIONS, description: '秒数，默认 5' },
          count: { type: 'integer', minimum: 1, maximum: 2, description: '默认 1' },
          name: { type: 'string', description: '节点名称（可选）' },
        },
        required: ['prompt'],
      },
      describe: (a) => clip(a.prompt ?? ''),
      async run(args, ctx) {
        const model: VideoModel = args.model === 'minimax-ref' ? 'minimax-ref' : 'minimax';
        const imageIds = args.image_ids ?? [];
        if (model === 'minimax' && imageIds.length > 2) throw new Error(t('minimax 最多 2 张图（首帧、尾帧）；要用更多参考图请用 minimax-ref'));
        if (model === 'minimax-ref' && !imageIds.length) throw new Error(t('minimax-ref 至少需要 1 张参考图'));
        if (imageIds.length > 9) throw new Error(t('参考图最多 {n} 张', { n: 9 }));
        const p = await readBoard(deps, ctx.projectId);
        const frames = findItems(p, imageIds);
        const media = inputMedia(deps, frames, 'image');
        const duration = snapDuration(args.duration);
        const request: TaskRequest = {
          op: 'video.generate',
          model,
          prompt: args.prompt,
          aspect: args.aspect?.trim() || (frames.length ? 'auto' : '16:9'),
          quality: args.quality === '720p' ? '720p' : '480p',
          duration,
          images: media.map((m) => m.id),
        };
        const count = Math.min(2, Math.max(1, Math.round(args.count ?? 1)));
        const { items, error } = await launch(deps, writer, ctx.projectId, { request, count, inputs: frames, name: args.name, view: ctx.view });
        return {
          text: `已提交 ${items.length} 段 ${duration} 秒视频，新节点：${items.map((i) => `\`${i.id}\``).join(' ')}。预计 GPU ${roughly(videoEstimate(deps.tasks.list(), request.quality, items.map(() => duration)).seconds)}（前面有排队任务会更久）。${error ? `另有 ${count - items.length} 段提交失败：${error}` : ''}`,
          summary: t('{n} 段已提交（{duration} 秒）', { n: items.length, duration }),
          items: items.map((i) => i.id),
        };
      },
    }),

    tool<Record<string, never>>({
      name: 'list_workflows',
      readOnly: true,
      label: msg('查看工作流'),
      description: '列出用户导入的 ComfyUI 工作流和官方模板里现在能用的那些：id、名称、输出图片还是视频、需要哪些输入和参数。',
      parameters: { type: 'object', properties: {} },
      describe: () => t('可用的工作流'),
      async run() {
        const caps = await deps.capabilities();
        const all = deps.workflows();
        const ready = all.filter((w) => !caps.features[`custom:${w.id}`]?.length && !w.inputs.some((i) => i.type === 'mask'));
        const lines = ready.map((w) => {
          const license = licenseLabel(`custom:${w.id}`, (zh) => zh);
          return `- \`${w.id}\`「${w.name}」输出${w.kind === 'video' ? '视频' : '图片'}${license ? ` · ${license}` : ''}${w.description ? ` · ${clip(w.description, 80)}` : ''}\n  输入：${inputsLine(w)}`;
        });
        const blocked = all.length - ready.length;
        return {
          text: (ready.length ? `能用的工作流 ${ready.length} 个：\n${lines.join('\n')}` : '没有能用的工作流') + (blocked ? `\n另有 ${blocked} 个缺模型、缺节点、需要蒙版或不可商用，暂时不能用` : ''),
          summary: t('{n} 个可用', { n: ready.length }),
        };
      },
    }),

    tool<{
      workflow_id: string;
      prompt?: string;
      negative?: string;
      image_ids?: string[];
      video_ids?: string[];
      aspect?: string;
      params?: Record<string, string | number | boolean>;
      count?: number;
      name?: string;
      group?: string;
    }>({
      name: 'run_workflow',
      label: msg('运行工作流'),
      description: '运行 list_workflows 里列出的工作流，结果放到画布上并连线。提交后立刻返回新节点 id。图片、视频输入按工作流里的顺序传节点 id。',
      parameters: {
        type: 'object',
        properties: {
          workflow_id: { type: 'string' },
          prompt: { type: 'string' },
          negative: { type: 'string' },
          image_ids: ids('图片输入的节点 id，按顺序'),
          video_ids: ids('视频输入的节点 id，按顺序'),
          aspect: { type: 'string', description: '画面比例（工作流有尺寸输入时才有用），如 16:9；auto = 跟第一张输入图一样' },
          params: { type: 'object', description: '其它参数：键是 list_workflows 里 params.<id> 的 id，值是字符串、数字或布尔' },
          count: { type: 'integer', minimum: 1, maximum: 4 },
          name: { type: 'string', description: '节点名称（可选）' },
          group: { type: 'string', description: '出图的工作流：图片类型，如「全身照」「脸部特写」「场景」「关键帧」：同一类型的图从上到下排成一列，画布上已有这一列时接在它下面（可选）' },
        },
        required: ['workflow_id'],
      },
      describe: (a) => a.workflow_id,
      async run(args, ctx) {
        const wf = deps.workflows().find((w) => w.id === args.workflow_id);
        if (!wf) throw new Error(t('没有 id 为 {id} 的工作流（用 list_workflows 查看）', { id: args.workflow_id }));
        if (wf.inputs.some((i) => i.type === 'mask')) throw new Error(t('这个工作流需要蒙版，请用户在画布上选中图片后手动运行'));
        const prompt = wf.inputs.find((i) => i.type === 'prompt');
        if (prompt && !String(prompt.default ?? '').trim() && !args.prompt?.trim()) throw new Error(t('这个工作流需要提示词'));
        const p = await readBoard(deps, ctx.projectId);
        const imageItems = findItems(p, args.image_ids ?? []);
        const videoItems = findItems(p, args.video_ids ?? []);
        for (const kind of ['image', 'video'] as const) {
          const slots = wf.inputs.filter((i) => i.type === kind);
          const given = (kind === 'image' ? imageItems : videoItems).length;
          const required = slots.filter((i) => !i.optional).length;
          const labels = list(slots.map((s) => t(s.label)));
          if (given > slots.length) throw new Error(kind === 'image' ? t('这个工作流最多 {n} 个图片输入', { n: slots.length }) : t('这个工作流最多 {n} 个视频输入', { n: slots.length }));
          if (given < required) throw new Error(kind === 'image' ? t('这个工作流需要 {n} 个图片输入：{list}', { n: required, list: labels }) : t('这个工作流需要 {n} 个视频输入：{list}', { n: required, list: labels }));
        }
        const images = inputMedia(deps, imageItems, 'image');
        const videos = inputMedia(deps, videoItems, 'video');
        const hasSize = wf.inputs.some((i) => i.type === 'width') && wf.inputs.some((i) => i.type === 'height');
        const request: TaskRequest = {
          op: 'custom',
          workflow: wf.id,
          prompt: args.prompt,
          negative: args.negative,
          images: images.map((m) => m.id),
          videos: videos.map((m) => m.id),
          aspect: hasSize ? args.aspect?.trim() || 'auto' : 'auto',
          params: args.params ?? {},
        };
        const count = Math.min(4, Math.max(1, Math.round(args.count ?? 1)));
        const { items, error } = await launch(deps, writer, ctx.projectId, {
          request,
          count,
          inputs: [...imageItems, ...videoItems],
          name: args.name ?? wf.name,
          group: args.group,
          images: wf.kind === 'image',
          view: ctx.view,
        });
        return {
          text: `已提交「${wf.name}」${items.length} 次，新节点：${items.map((i) => `\`${i.id}\``).join(' ')}。${error ? `另有 ${count - items.length} 次提交失败：${error}` : ''}`,
          summary: `${t(wf.name)} · ${t('{n} 个已提交', { n: items.length })}`,
          items: items.map((i) => i.id),
        };
      },
    }),

    tool<{ ids: string[]; timeout_seconds?: number }>({
      name: 'wait_for_items',
      readOnly: true,
      label: msg('等待结果'),
      description:
        '等这些节点生成完（或失败），返回每个的结果。需要拿结果做下一步时才用；视频很慢，除非用户要求，否则提交后不必等。超时后返回当前进度，可以再次调用。',
      parameters: {
        type: 'object',
        properties: {
          ids: { ...ids('要等的节点 id', 20), minItems: 1 },
          timeout_seconds: { type: 'integer', minimum: 10, maximum: 1200, description: '最多等多久，默认 300' },
        },
        required: ['ids'],
      },
      describe: (a) => t('{n} 个节点', { n: a.ids?.length ?? 0 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const items = findItems(p, args.ids);
        const taskIds = new Set(items.map((i) => i.taskId).filter(Boolean));
        const deadline = Date.now() + Math.min(1200, Math.max(10, args.timeout_seconds ?? 300)) * 1000;
        const states = () => items.map((item) => ({ item, state: stateOf(deps, item) }));
        const isOpen = (s: ReturnType<typeof stateOf>) => !s.done && !s.finished;

        const final = await new Promise<ReturnType<typeof states>>((resolve) => {
          let last = '';
          const check = () => {
            const now = states();
            const open = now.filter((s) => isOpen(s.state));
            const first = open[0]?.state;
            const line = `${now.length - open.length}/${now.length} 完成${first && !first.done ? ` · ${first.text}` : ''}`;
            if (line !== last) ctx.progress?.(line);
            last = line;
            if (!open.length || Date.now() >= deadline || ctx.signal?.aborted || ctx.interrupt?.aborted) {
              deps.tasks.off('task', onTask);
              clearInterval(timer);
              ctx.signal?.removeEventListener('abort', check);
              ctx.interrupt?.removeEventListener('abort', check);
              resolve(now);
            }
          };
          const onTask = (task: Task) => {
            if (taskIds.has(task.id)) check();
          };
          deps.tasks.on('task', onTask);
          const timer = setInterval(check, 5000);
          ctx.signal?.addEventListener('abort', check);
          ctx.interrupt?.addEventListener('abort', check);
          check();
        });

        ctx.seen?.(final.filter(({ state }) => !isOpen(state)).map(({ item }) => item.id));
        const lines = final.map(({ item, state }) =>
          state.done ? `\`${item.id}\` 完成（${state.media.width}×${state.media.height}）` : `\`${item.id}\` ${state.finished ? state.text : `还没好：${state.text}`}`,
        );
        const done = final.filter((s) => s.state.done).length;
        const open = final.filter((s) => isOpen(s.state)).length;
        const failed = final.length - done - open;
        return {
          text:
            lines.join('\n') +
            (!open ? '' : ctx.interrupt?.aborted ? '\n（用户发来了新消息，先停止等待）' : '\n（等待超时，可以稍后再调用 wait_for_items）'),
          summary: [t('{done}/{total} 完成', { done, total: final.length }), failed ? t('{n} 个失败', { n: failed }) : '', open ? t('{n} 个还在生成', { n: open }) : ''].filter(Boolean).join(t('，')),
          items: items.map((i) => i.id),
        };
      },
    }),

    tool<{ id?: string; title: string; content: string }>({
      name: 'write_note',
      label: msg('写文本'),
      description:
        '在画布上新建或更新一个文本节点，用来放剧本、角色设定、分镜表、备注。内容是简单的 Markdown，表格用 | 分隔。' +
        '更新时传 id，会整段替换。用户可能在画布上改过，改之前先用 read_board 读最新内容。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要更新的文本节点 id；不传就新建' },
          title: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['title', 'content'],
      },
      describe: (a) => a.title ?? '',
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const lines = args.content.split('\n').length;
        const wide = /^\s*\|/m.test(args.content);
        const size = { w: wide ? 760 : 440, h: Math.min(1400, Math.max(180, 64 + lines * 22)) };
        if (args.id) {
          const [item] = findItems(p, [args.id]);
          if (item.kind !== 'text') throw new Error(t('节点 {id} 不是文本节点', { id: args.id }));
          await patchBoard(deps, ctx.projectId, { upsert: [{ ...item, name: args.title.trim() || item.name, text: args.content, h: Math.max(item.h, size.h) }] });
          return { text: `已更新文本节点 \`${item.id}\``, summary: t('更新「{title}」', { title: args.title }), items: [item.id] };
        }
        const bounds = boundsOf(p.items);
        const start = ctx.view ? { x: ctx.view.x - size.w / 2, y: ctx.view.y - size.h / 2 } : bounds ? { x: bounds.x - size.w - GAP * 3, y: bounds.y } : { x: 0, y: 0 };
        const [pos] = placeRow(p.items, start, [size]);
        const note: CanvasItem = { id: nanoid(10), kind: 'text', x: Math.round(pos.x), y: Math.round(pos.y), ...size, name: args.title.trim(), text: args.content, createdAt: Date.now() };
        await patchBoard(deps, ctx.projectId, { upsert: [note] });
        return { text: `已新建文本节点 \`${note.id}\`「${note.name}」`, summary: t('「{title}」', { title: args.title }), items: [note.id] };
      },
    }),

    tool<{ jobs: { prompt: string; reference_ids?: string[]; aspect?: string; name?: string; group?: string }[]; model?: ImageModel; quality?: '1k' | '2k' }>({
      name: 'batch_generate_images',
      label: msg('批量出图'),
      description:
        `一次提交多张图（最多 ${MAX_BATCH} 张），每张有自己的提示词和参考图（规则同 generate_image）。` +
        '每张写 group（图片类型）：同一类型的图按顺序从上到下排成一列，不同类型的列并排；画布上已有这一类型的列时，新图接在它下面。同一类型的图在整个画布上用同一个 group 名。' +
        `提交后立刻返回；${afterBatch}分镜关键帧 group 写「关键帧」、按镜头顺序提交，name 写镜头编号。`,
      parameters: {
        type: 'object',
        properties: {
          jobs: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_BATCH,
            items: {
              type: 'object',
              properties: {
                prompt: { type: 'string' },
                reference_ids: ids('参考图节点 id（只有 qwen 支持，最多 10 张）', 10),
                aspect: { type: 'string', description: '如 16:9、9:16、1:1；auto = 跟第一张参考图一样' },
                name: { type: 'string', description: '节点名称，如 S01 或「程诺 · 全身」' },
                group: { type: 'string', description: '图片类型，如「全身照」「脸部特写」「场景」「关键帧」：同一类型的图从上到下排成一列，画布上已有这一列时接在它下面' },
              },
              required: ['prompt'],
            },
          },
          model: { type: 'string', enum: ['qwen', 'zimage'] },
          quality: { type: 'string', enum: ['1k', '2k'], description: '默认 1k' },
        },
        required: ['jobs'],
      },
      describe: (a) => t('{n} 张', { n: a.jobs?.length ?? 0 }),
      async run(args, ctx) {
        const model = imageModel(args.model);
        const p = await readBoard(deps, ctx.projectId);
        // Check every job before queueing any, so a bad id does not leave half a batch.
        const jobs: BatchJob[] = args.jobs.slice(0, MAX_BATCH).map((j, n) => {
          const refIds = j.reference_ids ?? [];
          if (model === 'zimage' && refIds.length) throw new Error(t('第 {n} 张：{reason}', { n: n + 1, reason: noReferences() }));
          const refs = findItems(p, refIds.slice(0, 10));
          const media = inputMedia(deps, refs, 'image');
          return {
            request: {
              op: 'image.generate',
              model,
              prompt: j.prompt,
              aspect: j.aspect?.trim() || (refs.length ? 'auto' : '1:1'),
              quality: args.quality === '2k' ? '2k' : '1k',
              images: media.map((m) => m.id),
            },
            inputs: refs,
            name: j.name,
            group: j.group,
          };
        });
        const { items, failed } = await launchBatch(deps, writer, ctx.projectId, jobs, { layout: 'groups', view: ctx.view });
        if (!items.length) throw new Error(failed[0]?.error ?? t('提交失败'));
        ctx.notify?.(t('{n} 张图片', { n: items.length }), items);
        const list = items.map((i) => `${i.name ? `${i.name} → ` : ''}\`${i.id}\``).join('\n');
        const errors = failed.map((f) => `第 ${f.index + 1} 张提交失败：${f.error}`).join('\n');
        return {
          text: `已提交 ${items.length} 张：\n${list}${errors ? `\n${errors}` : ''}\n${ctx.notify ? '全部结束时你会收到通知。' : afterBatch}`,
          summary: failed.length ? t('{n} 张已提交，{failed} 张失败', { n: items.length, failed: failed.length }) : t('{n} 张已提交', { n: items.length }),
          items: items.map((i) => i.id),
        };
      },
    }),

    tool<{ jobs: { prompt: string; first_frame_id: string; last_frame_id?: string; duration?: number; name?: string }[]; quality?: '480p' | '720p' }>({
      name: 'batch_generate_videos',
      label: msg('批量出视频'),
      description:
        `一次提交多段图生视频（MiniMax H3，最多 ${MAX_BATCH} 段），每段从自己的首帧图开始，可选尾帧；视频放在首帧右边。` +
        (host === 'panel'
          ? '这一步很耗 GPU，会先在面板上请用户确认：调用后告诉用户在等他确认，然后结束这一轮；用户确认后会自动提交，全部结束时你会收到通知。' +
            '确认卡弹出后又重做了某个镜头的首帧时（name 和 group 跟原来一样），不用重新提交：用户确认时会自动换成重做后的版本。再调用一次会让之前没确认的卡作废。'
          : `这一步很耗 GPU（一块 GPU 排队跑，get_context 里有实测速度，返回结果里有这一批的预计时间），调用前先跟用户确认。提交后立刻返回；${afterBatch}`),
      parameters: {
        type: 'object',
        properties: {
          jobs: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_BATCH,
            items: {
              type: 'object',
              properties: {
                prompt: { type: 'string' },
                first_frame_id: { type: 'string', description: '首帧图片节点 id' },
                last_frame_id: { type: 'string', description: '尾帧图片节点 id（可选）' },
                duration: { type: 'integer', enum: VIDEO_DURATIONS, description: '秒数，默认 5；镜头短也生成 5 秒，剪辑时再裁' },
                name: { type: 'string', description: '节点名称，如 S01' },
              },
              required: ['prompt', 'first_frame_id'],
            },
          },
          quality: { type: 'string', enum: ['480p', '720p'], description: '默认 480p' },
        },
        required: ['jobs'],
      },
      describe: (a) => t('{n} 段', { n: a.jobs?.length ?? 0 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const quality = args.quality === '720p' ? '720p' : '480p';
        const jobs = args.jobs.slice(0, MAX_BATCH).map((j) => {
          const frames = findItems(p, [j.first_frame_id, ...(j.last_frame_id ? [j.last_frame_id] : [])]);
          inputMedia(deps, frames, 'image');
          return { prompt: j.prompt, frames: frames.map((f) => f.id), duration: snapDuration(j.duration), name: j.name ?? null };
        });
        const seconds = jobs.reduce((n, j) => n + j.duration, 0);
        const since = Date.now();
        const estimate = videoEstimate(deps.tasks.list(), quality, jobs.map((j) => j.duration));
        const minutes = Math.max(1, Math.round(estimate.seconds / 60));
        if (host === 'mcp') {
          const out = await launchVideos({ quality, jobs }, ctx);
          return { ...out, text: `${out.text}\n预计 GPU 约 ${minutes} 分钟（共 ${seconds} 秒、${quality}）。` };
        }
        return {
          text: `已在面板上请用户确认：${jobs.length} 段、共 ${seconds} 秒、${quality}，预计 GPU 约 ${minutes} 分钟。用户确认后会自动提交，全部结束时你会收到通知。现在告诉用户在等他确认，然后结束这一轮。`,
          summary: t('等待确认'),
          approval: {
            title: t('生成 {n} 段视频', { n: jobs.length }),
            detail: t(
              estimate.measured
                ? '共 {seconds} 秒 · {quality} · 预计 GPU 约 {minutes} 分钟（按这台服务器以往的速度估算，期间其他生成任务要排队）'
                : '共 {seconds} 秒 · {quality} · 预计 GPU 约 {minutes} 分钟（按参考显卡的速度估算，期间其他生成任务要排队）',
              { seconds, quality, minutes },
            ),
            payload: { quality, jobs, since },
            frames: jobs.map((j) => j.frames[0]),
            since,
          },
        };
      },
      approve: launchVideos,
    }),

    tool<{ ids: string[] }>({
      name: 'review_items',
      readOnly: true,
      label: msg('审片'),
      vision: true,
      description:
        `把最多 16 个图片或视频节点拼成带编号的大图来检查：图片每 4 张拼一张，视频每段取开头、中间、结尾三帧（编号后面加 a、b、c），一次最多 ${MAX_REVIEW_CLIPS} 段视频。比一张张用 view_images 省。` +
        '检查：人物是不是同一个人、有没有多出来的人、背景对不对；人和家具、道具接触的地方（坐的椅子、靠的桌子、手里拿的东西）有没有粘在一起或穿过去；视频还要看动作有没有做出来、人物有没有变形。',
      parameters: { type: 'object', properties: { ids: { ...ids('节点 id', 16), minItems: 1 } }, required: ['ids'] },
      describe: (a) => t('{n} 个', { n: a.ids?.length ?? 0 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const items = findItems(p, args.ids.slice(0, 16));
        const stills: Tile[] = [];
        const clips: Tile[][] = [];
        const lines: string[] = [];
        const skipped: string[] = [];
        let n = 0;
        for (const item of items) {
          const state = stateOf(deps, item);
          const stored = state.done ? deps.assets.get(state.media.id) : undefined;
          if (!state.done || !stored) {
            skipped.push(`\`${item.id}\` (${state.done ? t('文件不见了') : state.text})`);
            continue;
          }
          const path = deps.assets.path(stored);
          if (stored.kind === 'video') {
            if (clips.length >= MAX_REVIEW_CLIPS) {
              skipped.push(`\`${item.id}\` (一次最多看 ${MAX_REVIEW_CLIPS} 段视频)`);
              continue;
            }
            const { duration } = await probe(path);
            const at = [Math.min(0.3, duration / 4), duration / 2, Math.max(0, duration - 0.4)];
            const label = String(++n);
            clips.push(await Promise.all(at.map(async (s, k) => ({ image: await videoFrame(path, s), label: `${label}${'abc'[k]}` }))));
            lines.push(`${label}a、${label}b、${label}c = 开头、中间、结尾：${describeItem(deps, item, 120)}`);
          } else {
            stills.push({ image: path, label: String(++n) });
            lines.push(`${n} = ${describeItem(deps, item, 120)}`);
          }
        }
        if (!n) throw new Error(t('没有可看的画面：{list}', { list: list(skipped) }));
        const sheets = await Promise.all([
          ...chunk(stills, 4).map((c) => contactSheet(c, 2)),
          ...chunk(clips, 2).map((c) => contactSheet(c.flat(), 3)),
        ]);
        return {
          text: `${sheets.length > 1 ? `共 ${sheets.length} 张拼图，图片在前、视频在后。` : ''}拼图里的编号：\n${lines.join('\n')}${skipped.length ? `\n跳过：${skipped.join('、')}` : ''}`,
          images: sheets.map((sheet) => ({ data: sheet.toString('base64'), mimeType: 'image/jpeg' })),
          summary: t('{n} 个', { n }),
          items: items.map((i) => i.id),
        };
      },
    }),

    tool<{ ids: string[] }>({
      name: 'inspect_clips',
      readOnly: true,
      label: msg('听声音'),
      description:
        '查看视频节点的时长，以及哪几秒有明显的声音（生成的镜头里通常就是台词；环境声很轻，不算）。剪辑前用它决定每段裁到哪里：台词常常在镜头后半段才说，别按分镜秒数直接裁掉。',
      parameters: { type: 'object', properties: { ids: { ...ids('视频节点 id', 40), minItems: 1 } }, required: ['ids'] },
      describe: (a) => t('{n} 段', { n: a.ids?.length ?? 0 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const items = findItems(p, args.ids);
        const media = inputMedia(deps, items, 'video');
        const lines: string[] = [];
        for (const [i, m] of media.entries()) {
          const stored = deps.assets.get(m.id);
          if (!stored) throw new Error(t('节点 {id} 的视频文件不见了', { id: items[i].id }));
          const path = deps.assets.path(stored);
          const info = await probe(path);
          const spans = info.hasAudio ? await soundSpans(path, info.duration) : [];
          const sound = !info.hasAudio ? '没有音轨' : spans.length ? `明显的声音在 ${spans.map((s) => `${s.start.toFixed(2)}–${s.end.toFixed(2)}`).join('、')} 秒` : '只有很轻的环境声，没有台词';
          lines.push(`\`${items[i].id}\`${items[i].name ? ` ${items[i].name}` : ''}：${info.duration.toFixed(2)} 秒；${sound}`);
        }
        return { text: lines.join('\n'), summary: t('{n} 段', { n: items.length }), items: items.map((i) => i.id) };
      },
    }),

    tool<{ clips: { id: string; start?: number; end?: number }[]; name?: string }>({
      name: 'assemble_video',
      label: msg('剪辑成片'),
      description:
        '按顺序把视频节点拼成一条成片（硬切），每段可以裁头尾（start/end 是这段里的秒数）。保留每段自带的声音。成片放在画布上，连回每一段。在运行服务的电脑上用 ffmpeg 处理，几十秒到几分钟。',
      parameters: {
        type: 'object',
        properties: {
          clips: {
            type: 'array',
            minItems: 1,
            maxItems: 80,
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } },
              required: ['id'],
            },
          },
          name: { type: 'string', description: '成片名称' },
        },
        required: ['clips'],
      },
      describe: (a) => t('{n} 段', { n: a.clips?.length ?? 0 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const items = findItems(p, args.clips.map((c) => c.id));
        const media = inputMedia(deps, items, 'video');
        const clips = media.map((m, i) => {
          const stored = deps.assets.get(m.id);
          if (!stored) throw new Error(t('节点 {id} 的视频文件不见了', { id: items[i].id }));
          return { path: deps.assets.path(stored), start: args.clips[i].start, end: args.clips[i].end };
        });
        // Speech that the trims would cut off: reported, so the model can fix the edit.
        const cutOff: string[] = [];
        for (const [i, c] of clips.entries()) {
          const info = await probe(c.path);
          if (!info.hasAudio) continue;
          const from = c.start ?? 0;
          const to = Math.min(info.duration, c.end ?? info.duration);
          for (const s of await soundSpans(c.path, info.duration)) {
            const lost = Math.max(0, Math.min(s.end, from) - s.start) + Math.max(0, s.end - Math.max(s.start, to));
            if (lost >= 0.3) cutOff.push(`${items[i].name ?? items[i].id} 的 ${s.start.toFixed(2)}–${s.end.toFixed(2)} 秒有明显的声音（可能是台词），保留的是 ${from}–${to.toFixed(2)} 秒`);
          }
        }
        ctx.progress?.(`剪辑 ${clips.length} 段…`);
        const dir = await mkdtemp(join(tmpdir(), 'infinode-cut-'));
        try {
          const out = join(dir, 'cut.mp4');
          await concatClips(clips, out, ctx.signal);
          const info = await probe(out);
          const name = args.name?.trim().slice(0, 60) || '成片';
          const asset = await deps.assets.save(await readFile(out), { filename: 'cut.mp4', mime: 'video/mp4', size: { width: info.width, height: info.height }, name });
          const fresh = await readBoard(deps, ctx.projectId);
          const b = boundsOf(items)!;
          const size = displaySize(info.width, info.height, 960);
          const [pos] = placeRow(fresh.items, { x: b.x + b.w + GAP * 4, y: b.y + (b.h - size.h) / 2 }, [size]);
          const item: CanvasItem = {
            id: nanoid(10),
            kind: 'video',
            x: Math.round(pos.x),
            y: Math.round(pos.y),
            ...size,
            asset: publicAsset(asset),
            inputs: [...new Set(items.map((i) => i.id))],
            name,
            createdAt: Date.now(),
          };
          await patchBoard(deps, ctx.projectId, { upsert: [item] });
          const warning = cutOff.length ? `\n注意，这些声音被裁掉了：\n${cutOff.map((w) => `- ${w}`).join('\n')}\n如果是台词，调整裁剪范围后重新剪一版。` : '';
          return {
            text: `成片 \`${item.id}\`：${clips.length} 段，${info.duration.toFixed(1)} 秒，${info.width}×${info.height}${warning}`,
            summary: cutOff.length ? t('{duration} 秒，有 {n} 处声音被裁掉', { duration: info.duration.toFixed(1), n: cutOff.length }) : t('{duration} 秒', { duration: info.duration.toFixed(1) }),
            items: [item.id],
          };
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    }),

    tool<{ ids: string[]; remove?: boolean }>({
      name: 'cancel_items',
      destructive: true,
      label: msg('取消生成'),
      description: '取消这些节点还在排队或生成中的任务。remove=true 时顺便把这些占位节点从画布上删掉（只删还没有结果的，已经生成好的图和视频不会删）。',
      parameters: {
        type: 'object',
        properties: { ids: { ...ids('节点 id'), minItems: 1 }, remove: { type: 'boolean', description: '同时删掉这些占位节点，默认 false' } },
        required: ['ids'],
      },
      describe: (a) => t('{n} 个节点', { n: a.ids?.length ?? 0 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const items = findItems(p, args.ids);
        const cancelled: string[] = [];
        for (const item of items) {
          if (!item.taskId) continue;
          const [task] = deps.tasks.list([item.taskId]);
          if (task?.status !== 'queued' && task?.status !== 'running') continue;
          await deps.tasks.cancel(item.taskId);
          cancelled.push(item.id);
        }
        ctx.seen?.(items.map((i) => i.id));
        const removable = args.remove ? items.filter((i) => i.kind !== 'text' && !stateOf(deps, i).done).map((i) => i.id) : [];
        if (removable.length) await patchBoard(deps, ctx.projectId, { remove: removable });
        return {
          text: (cancelled.length ? `已取消：${cancelled.map((id) => `\`${id}\``).join(' ')}` : '这些节点没有进行中的任务') + (removable.length ? `；已从画布删掉 ${removable.length} 个占位` : ''),
          summary: removable.length ? t('取消了 {n} 个，删掉 {removed} 个占位', { n: cancelled.length, removed: removable.length }) : t('取消了 {n} 个', { n: cancelled.length }),
          items: cancelled.filter((id) => !removable.includes(id)),
        };
      },
    }),

    tool<{ ids: string[] }>({
      name: 'delete_items',
      destructive: true,
      label: msg('删除节点'),
      description:
        '把已经生成好的图片和视频从画布上删掉（用户说「删掉这几张」「不要的都删了」时）。' +
        (host === 'panel' ? '会先在面板上弹确认卡，用户点了才删；调用后告诉用户在等他确认，然后结束这一轮。' : '会直接删除，先问过用户再调用。') +
        '文件还留在资产库里，用户可以从那里加回画布，但节点的名字、类型、连线和生成参数不会保留，画布上也撤销不了。还在排队或生成中的用 cancel_items；文本节点不能用它删。',
      parameters: {
        type: 'object',
        properties: { ids: { ...ids('要删的节点 id'), minItems: 1 } },
        required: ['ids'],
      },
      describe: (a) => t('{n} 个节点', { n: a.ids?.length ?? 0 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const items = findItems(p, [...new Set(args.ids)]);
        const done = items.filter((i) => i.kind !== 'text' && stateOf(deps, i).done);
        const kept = items.filter((i) => !done.includes(i));
        if (!done.length) throw new Error(t('这些节点里没有已经生成好的图片或视频：还在生成的用 cancel_items，文本节点不能删'));
        const skipped = kept.length
          ? `\n没删：${kept.map((i) => `\`${i.id}\`（${i.kind === 'text' ? '文本节点' : '还没有结果，用 cancel_items'}）`).join('，')}`
          : '';
        const payload = { ids: done.map((i) => i.id) };
        if (host === 'mcp') {
          const out = await deleteItems(payload, ctx);
          return { ...out, text: out.text + skipped };
        }
        const images = done.filter((i) => i.kind === 'image').length;
        const videos = done.length - images;
        return {
          text: `已在面板上请用户确认删除 ${done.length} 个节点：${payload.ids.map((id) => `\`${id}\``).join(' ')}。用户点了才会删。现在告诉用户在等他确认，然后结束这一轮。${skipped}`,
          summary: t('等待确认'),
          approval: {
            title: !videos
              ? t('删除 {n} 张图', { n: images })
              : !images
                ? t('删除 {n} 段视频', { n: videos })
                : t('删除 {images} 张图和 {videos} 段视频', { images, videos }),
            detail: t('删掉后画布上撤销不了。文件还留在资产库里，可以从那里重新加回画布，但名字、连线和生成参数不会保留。'),
            payload,
            frames: payload.ids,
            confirm: t('删除'),
          },
        };
      },
      approve: deleteItems,
    }),

    tool<{ ids?: string[]; beside?: string; side?: Side; dx?: number; dy?: number; positions?: { id: string; x: number; y: number }[] }>({
      name: 'move_items',
      label: msg('移动节点'),
      description:
        '移动画布上的节点（坐标是画布坐标，x 向右、y 向下，位置指左上角；现在的位置和大小用 read_board 看）。三种用法选一种：' +
        '① ids + beside（另一个节点的 id）+ side（right / left / below / above，默认 right）：把这些节点整体放到那个节点旁边，彼此的相对位置不变，挡路的节点会自动让开；' +
        '② ids + dx / dy：整体平移；' +
        '③ positions：把每个节点放到给定坐标，比如放回原位。' +
        '画布上撤销不了助手的移动，返回里记着原位置，用户要放回去时用 positions。',
      parameters: {
        type: 'object',
        properties: {
          ids: ids('要移动的节点 id（用法 ① ②）'),
          beside: { type: 'string', description: '放到这个节点旁边（用法 ①）' },
          side: { type: 'string', enum: SIDES, description: '放在 beside 节点的哪一边，默认 right' },
          dx: { type: 'number', description: '向右移多少（负数向左）' },
          dy: { type: 'number', description: '向下移多少（负数向上）' },
          positions: {
            type: 'array',
            description: '每个节点的新位置（用法 ③）',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } },
              required: ['id', 'x', 'y'],
            },
          },
        },
      },
      describe: (a) => t('{n} 个节点', { n: a.positions?.length || a.ids?.length || 0 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const at = new Map<string, { x: number; y: number }>();
        let moved: CanvasItem[];
        if (args.positions?.length) {
          moved = findItems(p, [...new Set(args.positions.map((m) => m.id))]);
          for (const m of args.positions) {
            if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) throw new Error(t('positions 里的 x、y 要是数字'));
            at.set(m.id, { x: m.x, y: m.y });
          }
        } else {
          if (!args.ids?.length) throw new Error(t('要传 ids（配 beside 或 dx / dy），或者传 positions'));
          moved = findItems(p, [...new Set(args.ids)]);
          const b = boundsOf(moved)!;
          let dx: number;
          let dy: number;
          if (args.beside) {
            if (args.ids.includes(args.beside)) throw new Error(t('beside 的节点不能也在要移动的节点里'));
            const [anchor] = findItems(p, [args.beside]);
            const side = SIDES.includes(args.side as Side) ? (args.side as Side) : 'right';
            const ours = new Set(moved.map((i) => i.id));
            const spot = clearOf(p.items.filter((i) => !ours.has(i.id)), besideOf(anchor, b, side), side);
            dx = spot.x - b.x;
            dy = spot.y - b.y;
          } else {
            dx = Number(args.dx ?? 0);
            dy = Number(args.dy ?? 0);
            if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) throw new Error(t('要传 beside，或者不全为 0 的 dx / dy'));
          }
          for (const i of moved) at.set(i.id, { x: i.x + dx, y: i.y + dy });
        }
        await patchBoard(deps, ctx.projectId, {
          upsert: moved.map((i) => ({ ...i, x: Math.round(at.get(i.id)!.x), y: Math.round(at.get(i.id)!.y) })),
        });
        const b = boundsOf(moved.map((i) => ({ ...i, ...at.get(i.id)! })))!;
        return {
          text: `已移动 ${moved.length} 个节点，现在整体在 (${Math.round(b.x)},${Math.round(b.y)})，占 ${Math.round(b.w)}×${Math.round(b.h)}。${formerly(moved)}`,
          summary: t('移动了 {n} 个', { n: moved.length }),
          items: moved.map((i) => i.id),
        };
      },
    }),

    tool<{ ids: string[]; layout: Arrangement; columns?: number; gap?: number }>({
      name: 'arrange_items',
      label: msg('排列节点'),
      description:
        '把这些节点重新排整齐，顺序就是 ids 的顺序（比如按镜头号排）。layout：row 排成一行（顶端对齐）；column 排成一列（左边对齐）；' +
        'grid 排成网格（columns 列，不传就接近正方形）；groups 按类型（group）分列，同一类型从上到下一列，各列按类型第一次出现的顺序从左到右，没有类型的节点单独一列。' +
        '排好的整块放在这些节点原来所在区域的左上角，挡到别的节点时往右让开。画布上撤销不了，返回里记着原位置，用户要放回去时用 move_items 的 positions。',
      parameters: {
        type: 'object',
        properties: {
          ids: { ...ids('要排的节点 id，按排列顺序', MAX_LISTED), minItems: 1 },
          layout: { type: 'string', enum: ARRANGEMENTS },
          columns: { type: 'integer', minimum: 1, description: 'grid 的列数' },
          gap: { type: 'number', minimum: 0, description: `节点之间的间距，默认 ${GAP}` },
        },
        required: ['ids', 'layout'],
      },
      describe: (a) => t('{n} 个节点', { n: a.ids?.length ?? 0 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const items = findItems(p, [...new Set(args.ids)]);
        const layout = ARRANGEMENTS.includes(args.layout) ? args.layout : 'grid';
        const gap = typeof args.gap === 'number' && Number.isFinite(args.gap) ? Math.min(Math.max(0, args.gap), 1000) : GAP;
        const { positions, w, h } = arrange(items, layout, { columns: args.columns, gap });
        const b = boundsOf(items)!;
        const ours = new Set(items.map((i) => i.id));
        const spot = clearOf(p.items.filter((i) => !ours.has(i.id)), { x: b.x, y: b.y, w, h }, 'right');
        await patchBoard(deps, ctx.projectId, {
          upsert: items.map((i, n) => ({ ...i, x: Math.round(spot.x + positions[n].x), y: Math.round(spot.y + positions[n].y) })),
        });
        return {
          text: `已把 ${items.length} 个节点排成${ARRANGED[layout]}，整体在 (${Math.round(spot.x)},${Math.round(spot.y)})，占 ${Math.round(w)}×${Math.round(h)}。${formerly(items)}`,
          summary: t('排好了 {n} 个', { n: items.length }),
          items: items.map((i) => i.id),
        };
      },
    }),
  ];
}

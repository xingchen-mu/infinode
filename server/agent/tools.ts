import type { ImageModel, Task, TaskRequest, VideoModel, WorkflowInput, WorkflowLike } from '../../shared/types.ts';
import {
  type CanvasDeps,
  type ResultWriter,
  describeItem,
  findItems,
  inputMedia,
  launch,
  readBoard,
  stateOf,
} from './board.ts';

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
}

export interface ToolOutput {
  /** What the model reads. */
  text: string;
  images?: { data: string; mimeType: string }[];
  /** One line for the panel. */
  summary: string;
  /** Board items to show with the call. */
  items?: string[];
}

/** A canvas operation, independent of the agent runtime (plain JSON Schema parameters). */
export interface CanvasTool<A = Record<string, unknown>> {
  name: string;
  /** Short name for the panel. */
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Only offered to models that can see images. */
  vision?: boolean;
  /** What a call is doing, from its arguments. */
  describe(args: A): string;
  run(args: A, ctx: ToolContext): Promise<ToolOutput>;
}

const tool = <A>(t: CanvasTool<A>) => t as unknown as CanvasTool;

const ids = (description: string, max?: number) => ({
  type: 'array',
  items: { type: 'string' },
  description,
  ...(max ? { maxItems: max } : {}),
});

const clip = (s: string, max = 40) => (s.length > max ? `${s.slice(0, max)}…` : s);

const VIDEO_DURATIONS = [3, 5, 8, 10];
const MAX_LISTED = 300;
const VIEWABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);

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

export function canvasTools(deps: CanvasDeps, writer: ResultWriter): CanvasTool[] {
  return [
    tool<{ ids?: string[] }>({
      name: 'read_board',
      label: '读取画布',
      description:
        '列出画布上的节点：id、图片还是视频、名称、尺寸或生成状态、由哪些节点生成、提示词。传 ids 时只看这些节点，给出完整提示词和生成参数。',
      parameters: { type: 'object', properties: { ids: ids('只看这些节点（可选）') } },
      describe: (a) => (a.ids?.length ? `${a.ids.length} 个节点` : '全部节点'),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        if (args.ids?.length) {
          const items = findItems(p, args.ids);
          return {
            text: items.map((i) => describeItem(deps, i, 4000) + settingsOf(i.request)).join('\n'),
            summary: `${items.length} 个节点`,
            items: items.map((i) => i.id),
          };
        }
        const shown = p.items.slice(-MAX_LISTED);
        const lines = shown.map((i) => `- ${describeItem(deps, i)}`);
        const more = p.items.length > shown.length ? `\n（只列出了最新的 ${shown.length} 个）` : '';
        return {
          text: p.items.length ? `画布「${p.name}」共 ${p.items.length} 个节点：\n${lines.join('\n')}${more}` : `画布「${p.name}」是空的`,
          summary: `${p.items.length} 个节点`,
        };
      },
    }),

    tool<{ ids: string[] }>({
      name: 'view_images',
      label: '查看图片',
      vision: true,
      description: '查看画布上的图片节点（一次最多 4 张），用来检查生成质量或看懂参考图。视频看不了，可以看它的首帧或参考图。',
      parameters: { type: 'object', properties: { ids: { ...ids('图片节点 id', 4), minItems: 1 } }, required: ['ids'] },
      describe: (a) => `${a.ids?.length ?? 0} 张`,
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
        return { text: lines.join('\n'), images, summary: `${images.length} 张图片`, items: items.map((i) => i.id) };
      },
    }),

    tool<{ prompt: string; model?: ImageModel; reference_ids?: string[]; aspect?: string; quality?: '1k' | '2k'; count?: number; name?: string }>({
      name: 'generate_image',
      label: '生成图片',
      description:
        '在画布上生成图片，结果放在第一张参考图旁边并连线。提交后立刻返回新节点 id，不等结果。' +
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
        },
        required: ['prompt'],
      },
      describe: (a) => clip(a.prompt ?? ''),
      async run(args, ctx) {
        const model: ImageModel = args.model === 'zimage' ? 'zimage' : 'qwen';
        const refIds = args.reference_ids ?? [];
        if (model === 'zimage' && refIds.length) throw new Error('zimage 不支持参考图，要用参考图请用 qwen');
        if (refIds.length > 10) throw new Error('参考图最多 10 张');
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
        const { items, error } = await launch(deps, writer, ctx.projectId, { request, count, inputs: refs, name: args.name, view: ctx.view });
        const made = items.map((i) => `\`${i.id}\``).join(' ');
        return {
          text: `已提交 ${items.length} 张，新节点：${made}。每张约 30–60 秒（前面有排队任务会更久）。${error ? `另有 ${count - items.length} 张提交失败：${error}` : ''}`,
          summary: `${items.length} 张已提交`,
          items: items.map((i) => i.id),
        };
      },
    }),

    tool<{ prompt: string; model?: VideoModel; image_ids?: string[]; aspect?: string; quality?: '480p' | '720p'; duration?: number; count?: number; name?: string }>({
      name: 'generate_video',
      label: '生成视频',
      description:
        '用 MiniMax H3 在画布上生成带音频的视频，提交后立刻返回新节点 id，不等结果。很慢：每段 10 分钟以上，GPU 一次只跑一个任务。' +
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
        if (model === 'minimax' && imageIds.length > 2) throw new Error('minimax 最多 2 张图（首帧、尾帧）；要用更多参考图请用 minimax-ref');
        if (model === 'minimax-ref' && !imageIds.length) throw new Error('minimax-ref 至少需要 1 张参考图');
        if (imageIds.length > 9) throw new Error('参考图最多 9 张');
        const p = await readBoard(deps, ctx.projectId);
        const frames = findItems(p, imageIds);
        const media = inputMedia(deps, frames, 'image');
        const wanted = Number(args.duration) || 5;
        const duration = VIDEO_DURATIONS.reduce((best, d) => (Math.abs(d - wanted) < Math.abs(best - wanted) ? d : best));
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
          text: `已提交 ${items.length} 段 ${duration} 秒视频，新节点：${items.map((i) => `\`${i.id}\``).join(' ')}。每段要 10 分钟以上。${error ? `另有 ${count - items.length} 段提交失败：${error}` : ''}`,
          summary: `${items.length} 段已提交（${duration} 秒）`,
          items: items.map((i) => i.id),
        };
      },
    }),

    tool<Record<string, never>>({
      name: 'list_workflows',
      label: '查看工作流',
      description: '列出用户导入的 ComfyUI 工作流和官方模板里现在能用的那些：id、名称、输出图片还是视频、需要哪些输入和参数。',
      parameters: { type: 'object', properties: {} },
      describe: () => '可用的工作流',
      async run() {
        const caps = await deps.capabilities();
        const all = deps.workflows();
        const ready = all.filter((w) => !caps.features[`custom:${w.id}`]?.length && !w.inputs.some((i) => i.type === 'mask'));
        const lines = ready.map(
          (w) =>
            `- \`${w.id}\`「${w.name}」输出${w.kind === 'video' ? '视频' : '图片'}${w.description ? ` · ${clip(w.description, 80)}` : ''}\n  输入：${inputsLine(w)}`,
        );
        const blocked = all.length - ready.length;
        return {
          text: (ready.length ? `能用的工作流 ${ready.length} 个：\n${lines.join('\n')}` : '没有能用的工作流') + (blocked ? `\n另有 ${blocked} 个缺模型、缺节点或需要蒙版，暂时不能用` : ''),
          summary: `${ready.length} 个可用`,
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
    }>({
      name: 'run_workflow',
      label: '运行工作流',
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
        },
        required: ['workflow_id'],
      },
      describe: (a) => a.workflow_id,
      async run(args, ctx) {
        const wf = deps.workflows().find((w) => w.id === args.workflow_id);
        if (!wf) throw new Error(`没有 id 为 ${args.workflow_id} 的工作流（用 list_workflows 查看）`);
        if (wf.inputs.some((i) => i.type === 'mask')) throw new Error('这个工作流需要蒙版，请用户在画布上选中图片后手动运行');
        const prompt = wf.inputs.find((i) => i.type === 'prompt');
        if (prompt && !String(prompt.default ?? '').trim() && !args.prompt?.trim()) throw new Error('这个工作流需要提示词');
        const p = await readBoard(deps, ctx.projectId);
        const imageItems = findItems(p, args.image_ids ?? []);
        const videoItems = findItems(p, args.video_ids ?? []);
        for (const kind of ['image', 'video'] as const) {
          const slots = wf.inputs.filter((i) => i.type === kind);
          const given = (kind === 'image' ? imageItems : videoItems).length;
          const required = slots.filter((i) => !i.optional).length;
          const name = kind === 'image' ? '图片' : '视频';
          if (given > slots.length) throw new Error(`这个工作流最多 ${slots.length} 个${name}输入`);
          if (given < required) throw new Error(`这个工作流需要 ${required} 个${name}输入：${slots.map((s) => s.label).join('、')}`);
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
          view: ctx.view,
        });
        return {
          text: `已提交「${wf.name}」${items.length} 次，新节点：${items.map((i) => `\`${i.id}\``).join(' ')}。${error ? `另有 ${count - items.length} 次提交失败：${error}` : ''}`,
          summary: `${wf.name} · ${items.length} 个已提交`,
          items: items.map((i) => i.id),
        };
      },
    }),

    tool<{ ids: string[]; timeout_seconds?: number }>({
      name: 'wait_for_items',
      label: '等待结果',
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
      describe: (a) => `${a.ids?.length ?? 0} 个节点`,
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
          const onTask = (t: Task) => {
            if (taskIds.has(t.id)) check();
          };
          deps.tasks.on('task', onTask);
          const timer = setInterval(check, 5000);
          ctx.signal?.addEventListener('abort', check);
          ctx.interrupt?.addEventListener('abort', check);
          check();
        });

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
          summary: [`${done}/${final.length} 完成`, failed ? `${failed} 个失败` : '', open ? `${open} 个还在生成` : ''].filter(Boolean).join('，'),
          items: items.map((i) => i.id),
        };
      },
    }),

    tool<{ ids: string[] }>({
      name: 'cancel_items',
      label: '取消生成',
      description: '取消这些节点还在排队或生成中的任务。',
      parameters: { type: 'object', properties: { ids: { ...ids('节点 id'), minItems: 1 } }, required: ['ids'] },
      describe: (a) => `${a.ids?.length ?? 0} 个节点`,
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
        return {
          text: cancelled.length ? `已取消：${cancelled.map((id) => `\`${id}\``).join(' ')}` : '这些节点没有进行中的任务',
          summary: `取消了 ${cancelled.length} 个`,
          items: cancelled,
        };
      },
    }),
  ];
}

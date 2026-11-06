// Low-level `Server` on purpose: the canvas tools declare plain JSON Schema, which McpServer.registerTool does not take.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { type CallToolResult, CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { type CanvasDeps, ResultWriter, describeItem, readBoard } from '../agent/board.ts';
import { type CanvasTool, canvasTools } from '../agent/tools.ts';

/** What the open page last reported: its board, the selection and the board point at the center of its view. */
export interface Presence {
  projectId: string;
  selection: string[];
  view?: { x: number; y: number };
  at: number;
}

/** Tools whose results are new board items, which the page then brings into view. */
const CREATES = new Set(['generate_image', 'generate_video', 'batch_generate_images', 'batch_generate_videos', 'run_workflow', 'write_note', 'assemble_video']);
/** Codex gives a tool call 60 s by default: wait a bit less unless asked for longer. */
const WAIT_DEFAULT = 50;
/** A page that reported this recently still counts as what the user is looking at. */
const PRESENCE_TTL = 6 * 3600_000;

const INSTRUCTIONS = `Infinode is an infinite canvas on the user's own ComfyUI. Board items are images, videos or text notes; links show which items a result was made from.
- Start with get_context: the board the user has open and the items they selected ("this image", "these" mean those). Tools work on that board unless you pass board_id.
- Generation is asynchronous: generate_* / batch_* / run_workflow return new item ids at once; use wait_for_items to get results (each wait is capped, call again if it times out).
- One GPU runs everything in turn: an image takes about 30–60 s, a MiniMax H3 video 5–14 min per clip. Ask the user before queueing several videos.
- New items are placed and linked on the board automatically; the user watches the board update live.
- If the user switched on commercial-only mode, tools refuse research-only and non-commercial models and say what to use instead; list_workflows marks each template's license.
- Tool descriptions are in Chinese, the language of the app; reply in the user's language.`;

const BOARD_ID = { type: 'string', description: '画布 id；不传就用用户在页面上正在看的画布（见 get_context）' };

/** Lets clients run read-only tools without asking (e.g. Codex's `default_tools_approval_mode = "writes"`). */
function hints(readOnly = false, destructive = false) {
  return { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: false };
}

function withBoard(schema: Record<string, unknown>) {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  return { ...schema, properties: { board_id: BOARD_ID, ...properties } };
}

/** Exposes the canvas tools to outside agents (Claude Code, Codex…) over MCP Streamable HTTP. */
export class CanvasMcp {
  private readonly tools: CanvasTool[];

  constructor(
    private readonly deps: CanvasDeps,
    private readonly presence: () => Presence | undefined,
    /** Asks open pages to bring new items into view. */
    private readonly reveal: (projectId: string, ids: string[]) => void,
    private readonly version: string,
  ) {
    this.tools = canvasTools(deps, new ResultWriter(deps), 'mcp');
  }

  /** Stateless: a fresh server per request, answered as plain JSON once the call is done. */
  async handle(req: Request): Promise<Response> {
    const server = new Server({ name: 'infinode', version: this.version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        ...this.own().map(({ name, title, description, inputSchema, readOnly }) => ({ name, title, description, inputSchema, annotations: hints(readOnly) })),
        ...this.tools.map((t) => ({
          name: t.name,
          title: t.label,
          description: t.description,
          inputSchema: withBoard(t.parameters),
          annotations: hints(t.readOnly, t.destructive),
        })),
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (r, extra) => this.call(r.params.name, (r.params.arguments ?? {}) as Record<string, unknown>, extra.signal));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      void server.close();
    }
  }

  /** The board a call is about: the one asked for, else the one open in the page, else the last edited. */
  private async board(id?: string): Promise<string> {
    if (id) return id;
    const p = this.presence();
    if (p && Date.now() - p.at < PRESENCE_TTL && (await this.deps.projects.get(p.projectId))) return p.projectId;
    const [latest] = (await this.deps.projects.list()).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!latest) throw new Error('还没有画布，先用 create_board 新建一个');
    return latest.id;
  }

  /** Tools that only make sense from outside the app. */
  private own() {
    return [
      {
        name: 'get_context',
        title: '当前画布',
        readOnly: true,
        description: '用户在页面上正在看的画布：名称、节点数、用户选中的节点（详情），以及其它画布。先调用它，弄清楚用户说的「这张」「选中的」是哪些节点。',
        inputSchema: { type: 'object', properties: {} },
        run: async () => {
          const p = this.presence();
          const live = p && Date.now() - p.at < PRESENCE_TTL ? p : undefined;
          const id = await this.board();
          const board = await readBoard(this.deps, id);
          const selected = (live?.projectId === id ? live.selection : []).map((s) => board.items.find((i) => i.id === s)).filter((i) => i !== undefined);
          const others = (await this.deps.projects.list()).filter((b) => b.id !== id).slice(0, 10);
          return [
            `${live?.projectId === id ? '用户正在看' : '最近编辑'}的画布：「${board.name}」（board_id \`${id}\`），共 ${board.items.length} 个节点。`,
            selected.length ? `用户选中了 ${selected.length} 个节点：\n${selected.map((i) => `- ${describeItem(this.deps, i, 300)}`).join('\n')}` : '用户没有选中节点。',
            others.length ? `其它画布：${others.map((b) => `「${b.name}」\`${b.id}\``).join('，')}` : '',
          ]
            .filter(Boolean)
            .join('\n');
        },
      },
      {
        name: 'list_boards',
        title: '所有画布',
        readOnly: true,
        description: '列出所有画布：id、名称、节点数、最后修改时间。',
        inputSchema: { type: 'object', properties: {} },
        run: async () => {
          const list = (await this.deps.projects.list()).sort((a, b) => b.updatedAt - a.updatedAt);
          return list.length ? list.map((b) => `- \`${b.id}\`「${b.name}」${b.itemCount} 个节点，${new Date(b.updatedAt).toLocaleString('zh-CN')}`).join('\n') : '还没有画布';
        },
      },
      {
        name: 'create_board',
        title: '新建画布',
        readOnly: false,
        description: '新建一个空画布，返回它的 board_id。用户要在页面上切换过去才看得到。',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
        run: async (args: Record<string, unknown>) => {
          const p = await this.deps.projects.create(typeof args.name === 'string' ? args.name : undefined);
          return `已新建画布「${p.name}」，board_id \`${p.id}\`。提醒用户在页面左上角切换到它。`;
        },
      },
    ];
  }

  private async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
    try {
      const own = this.own().find((t) => t.name === name);
      if (own) return { content: [{ type: 'text', text: await own.run(args) }] };
      const tool = this.tools.find((t) => t.name === name);
      if (!tool) throw new Error(`没有这个工具：${name}`);
      const missing = ((tool.parameters.required ?? []) as string[]).filter((k) => args[k] === undefined);
      if (missing.length) throw new Error(`缺少参数：${missing.join('、')}`);
      const { board_id: boardId, ...rest } = args;
      const projectId = await this.board(typeof boardId === 'string' ? boardId : undefined);
      const p = this.presence();
      const input = name === 'wait_for_items' && rest.timeout_seconds === undefined ? { ...rest, timeout_seconds: WAIT_DEFAULT } : rest;
      const out = await tool.run(input, { projectId, view: p?.projectId === projectId ? p.view : undefined, signal });
      if (out.items?.length && CREATES.has(name)) this.reveal(projectId, out.items);
      return {
        content: [{ type: 'text', text: out.text }, ...(out.images ?? []).map((img) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType }))],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
    }
  }
}

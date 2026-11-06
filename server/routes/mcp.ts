import { Hono } from 'hono';
import { RequestError } from '../workflows/index.ts';
import { t } from '../i18n.ts';
import type { Services } from '../services.ts';
import { isLocal } from '../http/local.ts';

export function registerMcpRoutes(app: Hono, { mcp, setPresence }: Pick<Services, 'mcp' | 'setPresence'>) {
  /** The open page reports what the user is looking at, so "this image" works for Claude Code or Codex. */
  app.put('/api/presence', async (c) => {
    if (!isLocal(c)) return c.json({ ok: true });
    const body = await c.req.json<{ projectId?: unknown; selection?: unknown; view?: { x?: unknown; y?: unknown } }>();
    if (typeof body.projectId !== 'string') throw new RequestError(t('请求格式错误'));
    const view = body.view && Number.isFinite(body.view.x) && Number.isFinite(body.view.y) ? { x: Number(body.view.x), y: Number(body.view.y) } : undefined;
    const selection = Array.isArray(body.selection) ? body.selection.filter((id): id is string => typeof id === 'string').slice(0, 200) : [];
    setPresence({ projectId: body.projectId, selection, view, at: Date.now() });
    return c.json({ ok: true });
  });
  // Same rule as the assistant: it can spend GPU time, so only this machine.
  app.all('/mcp', async (c) => {
    if (!isLocal(c)) return c.json({ error: t('只接受本机的 MCP 连接') }, 403);
    return mcp.handle(c.req.raw);
  });
}

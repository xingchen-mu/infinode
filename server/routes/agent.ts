import { Hono } from 'hono';
import { RequestError } from '../workflows/index.ts';
import { t } from '../i18n.ts';
import type { Services } from '../services.ts';
import { isLocal } from '../http/local.ts';

export function registerAgentRoutes(app: Hono, { agent }: Pick<Services, 'agent'>) {
  // The agent spends the owner's API credits: only this machine may use it, even with the canvas shared on the LAN.
  app.use('/api/agent/*', async (c, next) => {
    if (!isLocal(c)) return c.json({ error: t('画布助手只能在运行服务的这台电脑上使用') }, 403);
    await next();
  });
  app.get('/api/agent/status', (c) => c.json(agent.status));
  app.get('/api/agent/:projectId', async (c) => c.json(await agent.view(c.req.param('projectId'))));
  app.post('/api/agent/:projectId', async (c) => {
    const body = await c.req.json<{ text?: string; selection?: string[]; view?: { x: number; y: number } }>();
    await agent.send(c.req.param('projectId'), {
      text: typeof body.text === 'string' ? body.text : '',
      selection: Array.isArray(body.selection) ? body.selection.filter((id) => typeof id === 'string') : [],
      view: body.view,
    });
    return c.json({ ok: true });
  });
  app.post('/api/agent/:projectId/abort', async (c) => {
    await agent.abort(c.req.param('projectId'));
    return c.json({ ok: true });
  });
  app.post('/api/agent/:projectId/approve', async (c) => {
    const body = await c.req.json<{ id?: unknown; ok?: unknown }>();
    if (typeof body.id !== 'string') throw new RequestError(t('请求格式错误'));
    await agent.approve(c.req.param('projectId'), body.id, body.ok === true);
    return c.json({ ok: true });
  });
  app.delete('/api/agent/:projectId', async (c) => {
    await agent.clear(c.req.param('projectId'));
    return c.json({ ok: true });
  });
}

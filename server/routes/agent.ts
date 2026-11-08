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
  // Before /api/agent/:projectId, which would take "commands" for a board id.
  app.get('/api/agent/commands', async (c) => c.json(await agent.commands()));
  app.put('/api/agent/commands', async (c) => c.json(await agent.saveCommands(await c.req.json())));
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
  app.post('/api/agent/:projectId/condense', async (c) => {
    const body = await c.req.json<{ focus?: unknown }>().catch(() => ({}) as { focus?: unknown });
    await agent.condense(c.req.param('projectId'), typeof body.focus === 'string' ? body.focus : undefined);
    return c.json({ ok: true });
  });
  app.get('/api/agent/:projectId/memory', async (c) => c.json(await agent.memories(c.req.param('projectId'))));
  app.put('/api/agent/:projectId/memory', async (c) => {
    const body = await c.req.json<{ scope?: unknown; memory?: unknown }>();
    if (body.scope !== 'board' && body.scope !== 'user') throw new RequestError(t('请求格式错误'));
    return c.json(await agent.saveMemory(c.req.param('projectId'), body.scope, body.memory));
  });
  app.post('/api/agent/:projectId/answer', async (c) => {
    const body = await c.req.json<{ id?: unknown; answer?: unknown }>();
    if (typeof body.id !== 'string' || typeof body.answer !== 'string') throw new RequestError(t('请求格式错误'));
    await agent.answer(c.req.param('projectId'), body.id, body.answer);
    return c.json({ ok: true });
  });
  app.post('/api/agent/:projectId/plan', async (c) => {
    const body = await c.req.json<{ on?: unknown }>();
    if (typeof body.on !== 'boolean') throw new RequestError(t('请求格式错误'));
    await agent.setPlan(c.req.param('projectId'), body.on);
    return c.json({ ok: true });
  });
  app.post('/api/agent/:projectId/rewind', async (c) => {
    const body = await c.req.json<{ id?: unknown }>();
    if (typeof body.id !== 'string') throw new RequestError(t('请求格式错误'));
    return c.json(await agent.rewind(c.req.param('projectId'), body.id));
  });
  app.post('/api/agent/:projectId/approve', async (c) => {
    const body = await c.req.json<{ id?: unknown; ok?: unknown; prompts?: unknown }>();
    if (typeof body.id !== 'string') throw new RequestError(t('请求格式错误'));
    const prompts = Array.isArray(body.prompts) ? body.prompts.map((p) => (typeof p === 'string' ? p : '')) : undefined;
    await agent.approve(c.req.param('projectId'), body.id, body.ok === true, prompts);
    return c.json({ ok: true });
  });
  app.delete('/api/agent/:projectId', async (c) => {
    await agent.clear(c.req.param('projectId'));
    return c.json({ ok: true });
  });
}

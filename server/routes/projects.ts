import { Hono } from 'hono';
import type { Project } from '../../shared/types.ts';
import { ProjectConflict, type ItemsPatch } from '../projects/store.ts';
import { RequestError } from '../workflows/index.ts';
import { t } from '../i18n.ts';
import type { Services } from '../services.ts';

export function registerProjectsRoutes(app: Hono, { projects, agent, projectEvents }: Pick<Services, 'projects' | 'agent' | 'projectEvents'>) {
  app.get('/api/projects', async (c) => c.json(await projects.list()));
  app.post('/api/projects', async (c) => {
    const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
    return c.json(await projects.create(body.name));
  });
  app.get('/api/projects/:id', async (c) => {
    const p = await projects.get(c.req.param('id'));
    return p ? c.json(p) : c.json({ error: t('画布不存在') }, 404);
  });
  app.get('/api/projects/:id/snapshots', async (c) => c.json(await projects.listSnapshots(c.req.param('id'))));
  app.post('/api/projects/:id/snapshots', async (c) => {
    const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
    const snapshot = await projects.createSnapshot(c.req.param('id'), body.name);
    return snapshot ? c.json(snapshot) : c.json({ error: t('画布不存在') }, 404);
  });
  app.post('/api/projects/:id/snapshots/:snapshotId/restore', async (c) => {
    const project = await projects.restoreSnapshot(c.req.param('id'), c.req.param('snapshotId'));
    if (!project) return c.json({ error: t('快照不存在') }, 404);
    projectEvents.emit({ id: project.id, updatedAt: project.updatedAt, by: writer(c) });
    return c.json(project);
  });
  app.post('/api/projects/:id/branches', async (c) => {
    const body = await c.req.json<{ snapshotId?: string; name?: string }>();
    if (typeof body.snapshotId !== 'string') throw new RequestError(t('请求格式错误'));
    const project = await projects.branch(c.req.param('id'), body.snapshotId, body.name);
    return project ? c.json(project) : c.json({ error: t('快照不存在') }, 404);
  });
  /** Who made a change: the page's per-tab id, or "external" for scripts and agents. */
  const writer = (c: { req: { header(name: string): string | undefined } }) => (c.req.header('x-infinode-client') ?? 'external').slice(0, 64);

  app.put('/api/projects/:id', async (c) => {
    const { baseUpdatedAt, ...patch } = await c.req.json<Partial<Pick<Project, 'name' | 'items' | 'viewport'>> & { baseUpdatedAt?: number }>();
    // A whole-board save must say which version it started from; otherwise a page left open on old
    // code (or any blind writer) would wipe changes made since. Scripts use PATCH …/items instead.
    if (typeof baseUpdatedAt !== 'number') {
      const current = await projects.get(c.req.param('id'));
      if (!current) return c.json({ error: t('画布不存在') }, 404);
      return c.json({ error: t('页面版本过旧，请刷新页面'), project: current }, 409);
    }
    try {
      const p = await projects.save(c.req.param('id'), patch, baseUpdatedAt);
      if (!p) return c.json({ error: t('画布不存在') }, 404);
      projectEvents.emit({ id: p.id, updatedAt: p.updatedAt, by: writer(c) });
      return c.json({ updatedAt: p.updatedAt });
    } catch (err) {
      if (err instanceof ProjectConflict) return c.json({ error: err.message, project: err.project }, 409);
      throw err;
    }
  });
  // Scripts and agents: add / replace / remove items without overwriting what the page is doing.
  app.patch('/api/projects/:id/items', async (c) => {
    const body = await c.req.json<ItemsPatch>();
    if (!Array.isArray(body.upsert ?? []) || !Array.isArray(body.remove ?? [])) throw new RequestError(t('请求格式错误'));
    if ((body.upsert ?? []).some((i) => !i || typeof i.id !== 'string')) throw new RequestError(t('每个节点都需要 id'));
    const p = await projects.patchItems(c.req.param('id'), body);
    if (!p) return c.json({ error: t('画布不存在') }, 404);
    projectEvents.emit({ id: p.id, updatedAt: p.updatedAt, by: writer(c) });
    return c.json({ updatedAt: p.updatedAt, itemCount: p.items.length });
  });
  app.delete('/api/projects/:id', async (c) => {
    await projects.remove(c.req.param('id'));
    await agent.forget(c.req.param('id'));
    projectEvents.emit({ id: c.req.param('id'), updatedAt: Date.now(), by: writer(c), deleted: true });
    return c.json({ ok: true });
  });
}

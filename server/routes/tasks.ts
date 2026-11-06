import { Hono } from 'hono';
import type { TaskRequest } from '../../shared/types.ts';
import { blockReason, commercialBlock } from '../../shared/licenses.ts';
import { RequestError, featureKey } from '../workflows/index.ts';
import { t } from '../i18n.ts';
import type { Services } from '../services.ts';

export function registerTasksRoutes(app: Hono, { tasks, settings, capabilities }: Pick<Services, 'tasks' | 'settings' | 'capabilities'>) {
  app.get('/api/tasks', (c) => {
    const ids = c.req.query('ids');
    return c.json(tasks.list(ids ? ids.split(',').filter(Boolean) : undefined));
  });

  app.post('/api/tasks', async (c) => {
    const body = await c.req.json<{ request: TaskRequest; id?: string }>();
    const req = body?.request;
    if (!req || typeof req.op !== 'string') throw new RequestError(t('请求格式错误'));
    const block = settings.value.commercialOnly ? commercialBlock(featureKey(req)) : undefined;
    if (block) throw new RequestError(t('已开启「只用可商用的模型」：{reason}', { reason: blockReason(block, t) }));
    await capabilities.get(); // keeps the built-in tools' model picks current
    return c.json(await tasks.create(req, body.id));
  });

  app.post('/api/tasks/:id/cancel', async (c) => {
    const task = await tasks.cancel(c.req.param('id'));
    return task ? c.json(task) : c.json({ error: t('任务不存在') }, 404);
  });
}

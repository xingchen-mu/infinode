import { type Context, Hono } from 'hono';
import { t } from '../i18n.ts';
import { isLocal } from '../http/local.ts';
import type { Services } from '../services.ts';

// These write gigabytes into the models folders and may run commands on the ComfyUI server over SSH,
// so like the assistant they only take requests from this machine.
const refuse = (c: Context) => c.json({ error: t('只能在运行 Infinode 的这台电脑上下载模型') }, 403);

/** Downloading model files into ComfyUI's models folders (see server/models/installer.ts). */
export function registerModelsRoutes(app: Hono, { models }: Pick<Services, 'models'>) {
  app.get('/api/models/install', async (c) => c.json(await models.info()));
  app.get('/api/models/downloads', (c) => c.json(models.jobsList()));

  app.post('/api/models/plan', async (c) => {
    if (!isLocal(c)) return refuse(c);
    const { names } = await c.req.json<{ names?: unknown }>();
    return c.json(await models.plan(names));
  });

  app.post('/api/models/downloads', async (c) => {
    if (!isLocal(c)) return refuse(c);
    const { names } = await c.req.json<{ names?: unknown }>();
    return c.json(models.start(names));
  });

  app.post('/api/models/downloads/:id/cancel', (c) => {
    if (!isLocal(c)) return refuse(c);
    const job = models.cancel(c.req.param('id'));
    return job ? c.json(job) : c.json({ error: t('没有这个下载') }, 404);
  });
}

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { join } from 'node:path';
import { allowedHost, hostName } from './http/hosts.ts';
import { ComfyError } from './comfy/client.ts';
import { config } from './config.ts';
import { WorkflowFormatError } from './workflows/custom.ts';
import { RequestError } from './workflows/index.ts';
import { t } from './i18n.ts';
import type { Services } from './services.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerPresetsRoutes } from './routes/presets.ts';
import { registerWorkflowsRoutes } from './routes/workflows.ts';
import { registerAssetsRoutes } from './routes/assets.ts';
import { registerTasksRoutes } from './routes/tasks.ts';
import { registerEventsRoutes } from './routes/events.ts';
import { registerProjectsRoutes } from './routes/projects.ts';
import { registerAgentRoutes } from './routes/agent.ts';
import { registerMcpRoutes } from './routes/mcp.ts';

export function createApp(services: Services) {
  const app = new Hono();

  // Pages on other domains must not reach this API by rebinding their domain to 127.0.0.1 (DNS rebinding).
  app.use('*', async (c, next) => {
    const host = c.req.header('host');
    if (allowedHost(host, config.allowedHosts, !/^(127\.|::1$|localhost$)/.test(config.host))) return next();
    return c.json({ error: t('不接受来自 {host} 的访问：请用 localhost 或 IP 地址打开，或把这个域名加进 .env 的 ALLOWED_HOSTS', { host: hostName(host) || t('未知地址') }) }, 403);
  });

  app.onError((err, c) => {
    const status = err instanceof RequestError || err instanceof WorkflowFormatError ? 400 : err instanceof ComfyError ? 502 : 500;
    if (status === 500) console.error(err);
    return c.json({ error: err.message }, status);
  });

  app.get('/api/capabilities', async (c) => c.json(await services.capabilities.get(c.req.query('refresh') === '1')));
  registerSettingsRoutes(app, services);
  registerPresetsRoutes(app, services);
  registerWorkflowsRoutes(app, services);
  registerAssetsRoutes(app, services);
  registerTasksRoutes(app, services);
  registerEventsRoutes(app, services);
  registerProjectsRoutes(app, services);
  registerAgentRoutes(app, services);
  registerMcpRoutes(app, services);

  if (config.production) {
    app.use('/*', serveStatic({ root: join(config.appRoot, 'dist') }));
    app.get('*', serveStatic({ path: join(config.appRoot, 'dist/index.html') }));
  }
  return app;
}

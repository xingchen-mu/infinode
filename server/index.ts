import { serve } from '@hono/node-server';
import { config } from './config.ts';
import { createApp } from './app.ts';
import { createServices } from './services.ts';

const services = await createServices();
const { comfy, tasks, assets, comfyStatus, capabilities } = services;
const app = createApp(services);

comfy.connect(
  (e) => tasks.onComfyEvent(e),
  (online) => {
    comfyStatus.emit(online);
    if (online) {
      void capabilities.get(true);
      tasks.onReconnect();
    }
  },
);

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`infinode server on http://${config.host}:${info.port}  (ComfyUI: ${comfy.baseUrl})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void Promise.allSettled([tasks.flush(), assets.flush()]).then(() => process.exit(0));
  });
}

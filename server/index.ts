import { serve } from '@hono/node-server';
import { config } from './config.ts';
import { createApp } from './app.ts';
import { DataDirInUse, lockDataDir, watchParent } from './lock.ts';
import { createServices } from './services.ts';

// Before any store reads the folder: a second server on it would overwrite this one's indexes.
let release: () => void;
try {
  release = lockDataDir(config.dataDir, config.port);
} catch (err) {
  if (!(err instanceof DataDirInUse)) throw err;
  console.error(err.message);
  process.exit(1);
}
process.on('exit', () => release());

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

let stopping = false;
function shutdown(why: string) {
  if (stopping) return;
  stopping = true;
  console.log(`infinode server stopping (${why})`);
  void Promise.allSettled([tasks.flush(), assets.flush()]).then(() => process.exit(0));
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => shutdown(sig));

// Started by the desktop app: stop with it, even when it could not stop us (crash, force quit).
const parent = Number(process.env.INFINODE_PARENT_PID);
if (parent > 0) watchParent(parent, () => shutdown('the desktop app is gone'));

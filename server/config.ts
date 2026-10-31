import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

if (existsSync('.env')) process.loadEnvFile('.env');

export const config = {
  port: Number(process.env.PORT ?? 8787),
  /** 127.0.0.1 keeps the app private to this machine; 0.0.0.0 shares it on the LAN. */
  host: process.env.HOST ?? '127.0.0.1',
  comfyUrl: process.env.COMFY_URL ?? 'http://127.0.0.1:8188',
  dataDir: resolve(process.env.DATA_DIR ?? 'data'),
  production: process.env.NODE_ENV === 'production',
};

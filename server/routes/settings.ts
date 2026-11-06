import { Hono } from 'hono';
import { isLang } from '../../shared/i18n.ts';
import { ComfyClient } from '../comfy/client.ts';
import { normalizeComfyUrl } from '../settings.ts';
import { RequestError } from '../workflows/index.ts';
import { t } from '../i18n.ts';
import type { Services } from '../services.ts';

export function registerSettingsRoutes(app: Hono, { settings, comfy, assets, capabilities }: Pick<Services, 'settings' | 'comfy' | 'assets' | 'capabilities'>) {
  app.get('/api/settings', (c) => c.json(settings.value));

  /** Checks an address without saving it. */
  app.post('/api/settings/test', async (c) => {
    const { comfyUrl } = await c.req.json<{ comfyUrl: string }>();
    let url: string;
    try {
      url = normalizeComfyUrl(comfyUrl);
    } catch (err) {
      return c.json({ ok: false, error: t('地址格式不对：{message}', { message: (err as Error).message }) });
    }
    try {
      const probe = new ComfyClient(url, 'probe');
      const stats = await probe.systemStats();
      return c.json({ ok: true, url, version: stats.system.comfyui_version, gpu: stats.devices[0]?.name });
    } catch (err) {
      return c.json({ ok: false, url, error: (err as Error).message });
    }
  });

  app.put('/api/settings', async (c) => {
    const body = await c.req.json<{ comfyUrl?: string; commercialOnly?: boolean; language?: unknown }>();
    if (isLang(body.language) && body.language !== settings.value.language) {
      await settings.save({ language: body.language });
      capabilities.invalidate(); // its notes are in the old language
    }
    if (typeof body.commercialOnly === 'boolean' && body.commercialOnly !== Boolean(settings.value.commercialOnly)) {
      await settings.save({ commercialOnly: body.commercialOnly });
      capabilities.invalidate();
    }
    if (body.comfyUrl !== undefined) {
      let url: string;
      try {
        url = normalizeComfyUrl(body.comfyUrl);
      } catch (err) {
        throw new RequestError(t('地址格式不对：{message}', { message: (err as Error).message }));
      }
      if (url !== comfy.baseUrl) {
        await settings.save({ comfyUrl: url });
        assets.forgetComfyNames();
        comfy.setBaseUrl(url);
        capabilities.invalidate();
      }
    }
    return c.json({ settings: settings.value, capabilities: await capabilities.get(true) });
  });
}

import { Hono } from 'hono';
import { isLang } from '../../shared/i18n.ts';
import { ComfyClient } from '../comfy/client.ts';
import { normalizeComfyUrl } from '../settings.ts';
import { RequestError } from '../workflows/index.ts';
import { t } from '../i18n.ts';
import type { Services } from '../services.ts';

export function registerSettingsRoutes(app: Hono, { settings, comfy, assets, capabilities, agent }: Pick<Services, 'settings' | 'comfy' | 'assets' | 'capabilities' | 'agent'>) {
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
    const body = await c.req.json<{
      comfyUrl?: string;
      commercialOnly?: boolean;
      language?: unknown;
      agentModel?: string;
      agentBaseUrl?: string;
      agentApiKey?: string;
      clearAgentApiKey?: boolean;
      agentVision?: boolean;
      agentThinking?: string;
    }>();
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
    const agentChanged = body.agentModel !== undefined || body.agentBaseUrl !== undefined || body.agentApiKey !== undefined || body.clearAgentApiKey === true || body.agentVision !== undefined || body.agentThinking !== undefined;
    if (agentChanged) {
      let baseUrl: string | undefined;
      if (body.agentBaseUrl !== undefined) {
        const input = body.agentBaseUrl.trim();
        if (input) {
          try {
            const u = new URL(input);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(t('只支持 http / https 地址'));
            baseUrl = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
          } catch (err) {
            throw new RequestError(t('地址格式不对：{message}', { message: (err as Error).message }));
          }
        } else baseUrl = '';
      }
      await settings.saveAgentConfig({
        model: body.agentModel,
        baseUrl,
        apiKey: body.agentApiKey,
        clearApiKey: body.clearAgentApiKey,
        vision: typeof body.agentVision === 'boolean' ? body.agentVision : undefined,
        thinking: body.agentThinking,
      });
      await agent.reconfigure();
    }
    return c.json({ settings: settings.value, capabilities: await capabilities.get(true) });
  });
}

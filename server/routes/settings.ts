import { Hono } from 'hono';
import { isLang } from '../../shared/i18n.ts';
import { APPROVAL_MODES, type ApprovalMode } from '../../shared/types.ts';
import { ComfyClient } from '../comfy/client.ts';
import { CONTEXT_WINDOW, isContextWindow, isModelSource, normalizeComfyUrl } from '../settings.ts';
import { normalizeEndpoint } from '../models/sources.ts';
import { RequestError } from '../workflows/index.ts';
import { t } from '../i18n.ts';
import type { Services } from '../services.ts';

export function registerSettingsRoutes(app: Hono, { settings, comfy, assets, capabilities, agent, models }: Pick<Services, 'settings' | 'comfy' | 'assets' | 'capabilities' | 'agent' | 'models'>) {
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
      agentApprovalMode?: ApprovalMode;
      /** null: back to the default. */
      agentContextWindow?: number | null;
      agentReasoning?: boolean;
      modelSource?: unknown;
      modelEndpoint?: string;
      hfToken?: string;
      clearHfToken?: boolean;
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
        models.invalidate();
      }
    }
    if (body.modelSource !== undefined || body.modelEndpoint !== undefined || body.hfToken !== undefined || body.clearHfToken === true) {
      if (body.modelSource !== undefined && !isModelSource(body.modelSource)) throw new RequestError(t('未知的下载源'));
      let endpoint: string | undefined;
      if (typeof body.modelEndpoint === 'string') {
        try {
          endpoint = body.modelEndpoint.trim() ? normalizeEndpoint(body.modelEndpoint) : '';
        } catch (err) {
          throw new RequestError(t('地址格式不对：{message}', { message: (err as Error).message }));
        }
      }
      if (body.modelSource === 'custom' && !(endpoint ?? settings.value.modelEndpoint)) throw new RequestError(t('请填写自定义下载地址'));
      await settings.saveModelConfig({
        source: body.modelSource as typeof settings.value.modelSource,
        endpoint,
        hfToken: typeof body.hfToken === 'string' ? body.hfToken : undefined,
        clearHfToken: body.clearHfToken === true,
      });
    }
    const agentChanged =
      body.agentModel !== undefined ||
      body.agentBaseUrl !== undefined ||
      body.agentApiKey !== undefined ||
      body.clearAgentApiKey === true ||
      body.agentVision !== undefined ||
      body.agentThinking !== undefined ||
      body.agentApprovalMode !== undefined ||
      body.agentContextWindow !== undefined ||
      body.agentReasoning !== undefined;
    if (agentChanged) {
      if (body.agentContextWindow !== undefined && body.agentContextWindow !== null && !isContextWindow(body.agentContextWindow)) {
        throw new RequestError(t('上下文长度要填 {min}–{max} 之间的整数（单位 token）', { min: CONTEXT_WINDOW.min, max: CONTEXT_WINDOW.max }));
      }
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
        approvalMode: APPROVAL_MODES.includes(body.agentApprovalMode as ApprovalMode) ? body.agentApprovalMode : undefined,
        contextWindow: body.agentContextWindow,
        reasoning: typeof body.agentReasoning === 'boolean' ? body.agentReasoning : undefined,
      });
      await agent.reconfigure();
    }
    return c.json({ settings: settings.value, capabilities: await capabilities.get(true) });
  });
}

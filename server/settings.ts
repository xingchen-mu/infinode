import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Settings } from '../shared/types.ts';
import { config } from './config.ts';
import { isLang } from '../shared/i18n.ts';
import { setServerLang, t } from './i18n.ts';

export interface AgentConfig {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  vision: boolean;
  thinking: string;
}

/** Settings changed in the app (data/settings.json); .env only supplies the defaults. */
export class SettingsStore {
  private readonly file = join(config.dataDir, 'settings.json');
  value: Settings = { comfyUrl: config.comfyUrl };
  private agentApiKey?: string;

  async init() {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as Partial<Settings>;
      if (typeof saved.comfyUrl === 'string' && saved.comfyUrl) this.value.comfyUrl = saved.comfyUrl;
      if (saved.commercialOnly === true) this.value.commercialOnly = true;
      if (isLang(saved.language)) this.value.language = saved.language;
      if (typeof saved.agentModel === 'string' && saved.agentModel.trim()) this.value.agentModel = saved.agentModel.trim();
      if (typeof saved.agentBaseUrl === 'string' && saved.agentBaseUrl.trim()) this.value.agentBaseUrl = saved.agentBaseUrl.trim();
      if (typeof saved.agentVision === 'boolean') this.value.agentVision = saved.agentVision;
      if (typeof saved.agentThinking === 'string' && saved.agentThinking.trim()) this.value.agentThinking = saved.agentThinking.trim();
      const raw = saved as Partial<Settings> & { agentApiKey?: unknown };
      if (typeof raw.agentApiKey === 'string' && raw.agentApiKey.trim()) this.agentApiKey = raw.agentApiKey.trim();
    } catch {
      /* defaults */
    }
    // Surface the effective .env defaults in the settings UI while still allowing the user to override them.
    if (!this.value.agentModel && process.env.AGENT_MODEL?.trim()) this.value.agentModel = process.env.AGENT_MODEL.trim();
    if (!this.value.agentBaseUrl && process.env.AGENT_BASE_URL?.trim()) this.value.agentBaseUrl = process.env.AGENT_BASE_URL.trim();
    if (this.value.agentVision === undefined && process.env.AGENT_VISION !== undefined) this.value.agentVision = process.env.AGENT_VISION === '1';
    if (!this.value.agentThinking && process.env.AGENT_THINKING?.trim()) this.value.agentThinking = process.env.AGENT_THINKING.trim();
    if (this.value.language) setServerLang(this.value.language);
    this.updateAgentKeyStatus();
  }

  async save(patch: Partial<Settings>) {
    this.value = { ...this.value, ...patch };
    if (this.value.language) setServerLang(this.value.language);
    await this.persist();
    return this.value;
  }

  /** Effective assistant configuration: settings take precedence over .env defaults. */
  agentConfig(): AgentConfig {
    const model = this.value.agentModel?.trim() || process.env.AGENT_MODEL?.trim() || 'deepseek/deepseek-flash';
    const baseUrl = this.value.agentBaseUrl?.trim() || process.env.AGENT_BASE_URL?.trim() || undefined;
    const apiKey = this.agentApiKey || process.env.AGENT_API_KEY?.trim() || undefined;
    const vision = this.value.agentVision ?? process.env.AGENT_VISION === '1';
    const thinking = this.value.agentThinking?.trim() || process.env.AGENT_THINKING?.trim() || 'low';
    return { model, baseUrl, apiKey, vision, thinking };
  }

  async saveAgentConfig(patch: {
    model?: string;
    baseUrl?: string;
    vision?: boolean;
    thinking?: string;
    apiKey?: string;
    clearApiKey?: boolean;
  }) {
    if (patch.model !== undefined) {
      const model = patch.model.trim();
      if (model) this.value.agentModel = model;
      else delete this.value.agentModel;
    }
    if (patch.baseUrl !== undefined) {
      const baseUrl = patch.baseUrl.trim();
      if (baseUrl) this.value.agentBaseUrl = baseUrl;
      else delete this.value.agentBaseUrl;
    }
    if (patch.vision !== undefined) this.value.agentVision = patch.vision;
    if (patch.thinking !== undefined) {
      const thinking = patch.thinking.trim();
      if (thinking) this.value.agentThinking = thinking;
      else delete this.value.agentThinking;
    }
    if (patch.clearApiKey) this.agentApiKey = undefined;
    if (patch.apiKey?.trim()) this.agentApiKey = patch.apiKey.trim();
    this.updateAgentKeyStatus();
    await this.persist();
    return this.value;
  }

  private updateAgentKeyStatus() {
    this.value.agentApiKeyConfigured = Boolean(this.agentApiKey || process.env.AGENT_API_KEY?.trim());
  }

  private async persist() {
    const saved = { ...this.value, ...(this.agentApiKey ? { agentApiKey: this.agentApiKey } : {}) };
    await writeFile(`${this.file}.tmp`, JSON.stringify(saved, null, 1));
    await rename(`${this.file}.tmp`, this.file);
  }
}

/** "localhost:8188" → "http://localhost:8188"; rejects anything that is not http(s). */
export function normalizeComfyUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(t('只支持 http / https 地址'));
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelSource, Settings } from '../shared/types.ts';
import { config } from './config.ts';
import { isLang } from '../shared/i18n.ts';
import { setServerLang, t } from './i18n.ts';
import { MIRROR, OFFICIAL } from './models/sources.ts';

export interface AgentConfig {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  vision: boolean;
  thinking: string;
  approvalMode: 'risky' | 'always';
  /** For a custom endpoint: context length in tokens (unset: 128k) and whether the model reasons. */
  contextWindow?: number;
  reasoning: boolean;
}

/** Context lengths a custom endpoint may declare: the instructions and tools alone take about 8k tokens. */
export const CONTEXT_WINDOW = { min: 16_000, max: 10_000_000 } as const;
export const isContextWindow = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= CONTEXT_WINDOW.min && (v as number) <= CONTEXT_WINDOW.max;

/** AGENT_CONTEXT_WINDOW, when it is a usable length. */
function envContextWindow(): number | undefined {
  const n = Number(process.env.AGENT_CONTEXT_WINDOW?.trim() || NaN);
  return isContextWindow(n) ? n : undefined;
}

export interface ModelDownloadConfig {
  source: ModelSource;
  /** For 'custom'. */
  endpoint?: string;
  hfToken?: string;
}

const MODEL_SOURCES: readonly ModelSource[] = ['auto', 'huggingface', 'hf-mirror', 'custom'];
export const isModelSource = (v: unknown): v is ModelSource => MODEL_SOURCES.includes(v as ModelSource);

/** Settings changed in the app (data/settings.json); .env only supplies the defaults. */
export class SettingsStore {
  private readonly file = join(config.dataDir, 'settings.json');
  value: Settings = { comfyUrl: config.comfyUrl };
  private agentApiKey?: string;
  private hfToken?: string;

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
      if (isContextWindow(saved.agentContextWindow)) this.value.agentContextWindow = saved.agentContextWindow;
      if (typeof saved.agentReasoning === 'boolean') this.value.agentReasoning = saved.agentReasoning;
      if (saved.agentApprovalMode === 'risky' || saved.agentApprovalMode === 'always') this.value.agentApprovalMode = saved.agentApprovalMode;
      if (isModelSource(saved.modelSource)) this.value.modelSource = saved.modelSource;
      if (typeof saved.modelEndpoint === 'string' && saved.modelEndpoint.trim()) this.value.modelEndpoint = saved.modelEndpoint.trim();
      const raw = saved as Partial<Settings> & { agentApiKey?: unknown; hfToken?: unknown };
      if (typeof raw.agentApiKey === 'string' && raw.agentApiKey.trim()) this.agentApiKey = raw.agentApiKey.trim();
      if (typeof raw.hfToken === 'string' && raw.hfToken.trim()) this.hfToken = raw.hfToken.trim();
    } catch {
      /* defaults */
    }
    // Surface the effective .env defaults in the settings UI while still allowing the user to override them.
    if (!this.value.agentModel && process.env.AGENT_MODEL?.trim()) this.value.agentModel = process.env.AGENT_MODEL.trim();
    if (!this.value.agentBaseUrl && process.env.AGENT_BASE_URL?.trim()) this.value.agentBaseUrl = process.env.AGENT_BASE_URL.trim();
    if (this.value.agentVision === undefined && process.env.AGENT_VISION !== undefined) this.value.agentVision = process.env.AGENT_VISION === '1';
    if (!this.value.agentThinking && process.env.AGENT_THINKING?.trim()) this.value.agentThinking = process.env.AGENT_THINKING.trim();
    const envWindow = envContextWindow();
    if (this.value.agentContextWindow === undefined && envWindow) this.value.agentContextWindow = envWindow;
    if (this.value.agentReasoning === undefined && process.env.AGENT_REASONING !== undefined) this.value.agentReasoning = process.env.AGENT_REASONING === '1';
    if (this.value.language) setServerLang(this.value.language);
    this.updateAgentKeyStatus();
    this.updateHfTokenStatus();
  }

  /**
   * Effective model download settings. Without a saved choice, HF_ENDPOINT (the variable huggingface_hub
   * reads) picks a custom endpoint; otherwise 'auto'. HF_TOKEN works like a saved token.
   */
  modelConfig(): ModelDownloadConfig {
    const hfToken = this.hfToken || process.env.HF_TOKEN?.trim() || undefined;
    if (this.value.modelSource) {
      return { source: this.value.modelSource, endpoint: this.value.modelSource === 'custom' ? this.value.modelEndpoint : undefined, hfToken };
    }
    const envEndpoint = process.env.HF_ENDPOINT?.trim().replace(/\/+$/, '');
    if (envEndpoint === MIRROR) return { source: 'hf-mirror', hfToken };
    if (envEndpoint === OFFICIAL) return { source: 'huggingface', hfToken };
    if (envEndpoint) return { source: 'custom', endpoint: envEndpoint, hfToken };
    return { source: 'auto', hfToken };
  }

  async saveModelConfig(patch: { source?: ModelSource; endpoint?: string; hfToken?: string; clearHfToken?: boolean }) {
    if (patch.source) this.value.modelSource = patch.source;
    if (patch.endpoint !== undefined) {
      if (patch.endpoint) this.value.modelEndpoint = patch.endpoint;
      else delete this.value.modelEndpoint;
    }
    if (patch.clearHfToken) this.hfToken = undefined;
    if (patch.hfToken?.trim()) this.hfToken = patch.hfToken.trim();
    this.updateHfTokenStatus();
    await this.persist();
    return this.value;
  }

  private updateHfTokenStatus() {
    this.value.hfTokenConfigured = Boolean(this.hfToken || process.env.HF_TOKEN?.trim());
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
    const approvalMode = this.value.agentApprovalMode === 'always' ? 'always' : 'risky';
    const contextWindow = this.value.agentContextWindow ?? envContextWindow();
    const reasoning = this.value.agentReasoning ?? process.env.AGENT_REASONING === '1';
    return { model, baseUrl, apiKey, vision, thinking, approvalMode, contextWindow, reasoning };
  }

  async saveAgentConfig(patch: {
    model?: string;
    baseUrl?: string;
    vision?: boolean;
    thinking?: string;
    approvalMode?: 'risky' | 'always';
    /** null: back to the default. */
    contextWindow?: number | null;
    reasoning?: boolean;
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
    if (patch.approvalMode !== undefined) this.value.agentApprovalMode = patch.approvalMode;
    if (patch.contextWindow === null) delete this.value.agentContextWindow;
    else if (patch.contextWindow !== undefined) this.value.agentContextWindow = patch.contextWindow;
    if (patch.reasoning !== undefined) this.value.agentReasoning = patch.reasoning;
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
    const saved = { ...this.value, ...(this.agentApiKey ? { agentApiKey: this.agentApiKey } : {}), ...(this.hfToken ? { hfToken: this.hfToken } : {}) };
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

import { AlertTriangle, CheckCircle2, Download, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LANGS, type Lang } from '../../shared/i18n';
import { LICENSES, isBlock, licenseLabel, licenseTitle } from '../../shared/licenses';
import type { ModelInstallInfo, ModelSource, Settings } from '../../shared/types';
import { activeDownload, openDownloads } from '../models/actions';
import { SourcePicker, modeLine, sourceHelp } from '../models/DownloadsModal';
import { api } from '../lib/api';
import { unavailableReason } from '../generation/models';
import { setComposer, toast, useStore } from '../store';
import { lang, rememberLang, rich, t } from '../i18n';
import { Modal } from '../components/Modal';

const close = () => useStore.setState({ modal: null });

/** The saved assistant settings, to tell whether the form changed. */
const agentSnapshot = (s: Settings) =>
  JSON.stringify([
    s.agentModel ?? '',
    s.agentBaseUrl ?? '',
    Boolean(s.agentVision),
    s.agentThinking ?? 'low',
    s.agentApprovalMode ?? 'risky',
    s.agentContextWindow ? String(s.agentContextWindow) : '',
    Boolean(s.agentReasoning),
    Boolean(s.agentApiKeyConfigured),
  ]);

const BUILTIN_NAMES: Record<string, string> = {
  'image.generate:qwen': t('Qwen-Image 2.1 生图 / 参考图编辑'),
  'image.generate:zimage': t('Z-Image Turbo 文生图'),
  'image.inpaint': t('局部重绘'),
  'image.erase': t('消除'),
  'image.outpaint': t('扩图'),
  'image.removeBg': t('抠图'),
  'image.upscale': t('SeedVR2 超清'),
  'video.generate:minimax': t('MiniMax H3 视频'),
  'video.generate:minimax-ref': t('MiniMax H3 多图参考视频'),
};

export function SettingsModal() {
  const caps = useStore((s) => s.caps);
  const workflows = useStore((s) => s.workflows);
  const [url, setUrl] = useState('');
  const [saved, setSaved] = useState('');
  const [commercial, setCommercial] = useState(false);
  const [agentModel, setAgentModel] = useState('');
  const [agentBaseUrl, setAgentBaseUrl] = useState('');
  const [agentApiKey, setAgentApiKey] = useState('');
  const [agentKeyConfigured, setAgentKeyConfigured] = useState(false);
  const [agentVision, setAgentVision] = useState(false);
  const [agentThinking, setAgentThinking] = useState('low');
  const [agentApprovalMode, setAgentApprovalMode] = useState<'risky' | 'always'>('risky');
  const [agentContextWindow, setAgentContextWindow] = useState('');
  const [agentReasoning, setAgentReasoning] = useState(false);
  const [agentSaved, setAgentSaved] = useState('');
  const [busy, setBusy] = useState<'test' | 'save' | 'license' | 'agent' | 'models' | null>(null);
  const downloads = useStore((s) => s.downloads);
  const [install, setInstall] = useState<ModelInstallInfo | null>(null);
  const [modelSource, setModelSource] = useState<ModelSource>('auto');
  const [modelEndpoint, setModelEndpoint] = useState('');
  const [hfToken, setHfToken] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const showAgent = (s: Settings) => {
    setAgentModel(s.agentModel ?? '');
    setAgentBaseUrl(s.agentBaseUrl ?? '');
    setAgentKeyConfigured(Boolean(s.agentApiKeyConfigured));
    setAgentVision(Boolean(s.agentVision));
    setAgentThinking(s.agentThinking ?? 'low');
    setAgentApprovalMode(s.agentApprovalMode ?? 'risky');
    setAgentContextWindow(s.agentContextWindow ? String(s.agentContextWindow) : '');
    setAgentReasoning(Boolean(s.agentReasoning));
    setAgentSaved(agentSnapshot(s));
  };

  useEffect(() => {
    void api.settings().then((s) => {
      setUrl(s.comfyUrl);
      setSaved(s.comfyUrl);
      setCommercial(Boolean(s.commercialOnly));
      showAgent(s);
    });
    void loadInstall();
  }, []);

  const loadInstall = async () => {
    try {
      const info = await api.modelInstall();
      setInstall(info);
      setModelSource(info.source);
      setModelEndpoint(info.endpoint ?? '');
    } catch {
      /* server offline */
    }
  };

  const saveModels = async (patch: { modelSource?: ModelSource; modelEndpoint?: string; hfToken?: string; clearHfToken?: boolean }) => {
    setBusy('models');
    try {
      await api.saveSettings(patch);
      setHfToken('');
      await loadInstall();
      toast(t('下载设置已保存'), 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const pickSource = (source: ModelSource) => {
    setModelSource(source);
    // A custom endpoint is saved with its address below.
    if (source !== 'custom') void saveModels({ modelSource: source });
  };

  const switchCommercial = async (on: boolean) => {
    setBusy('license');
    setCommercial(on);
    try {
      const r = await api.saveSettings({ commercialOnly: on });
      useStore.setState({ caps: r.capabilities, comfyOnline: r.capabilities.comfyOnline });
      setCommercial(Boolean(r.settings.commercialOnly));
      // Research-only Qwen-Image 2.1 is off now: start new images with Z-Image Turbo instead.
      if (on && useStore.getState().composer.imageModel === 'qwen') setComposer({ imageModel: 'zimage' });
      toast(on ? t('已开启：不能商用的模型已停用') : t('已关闭：所有模型都可以用，许可证由你自己负责'), 'success');
    } catch (err) {
      setCommercial(!on);
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    try {
      const r = await api.testComfy(url);
      setResult(r.ok ? { ok: true, text: t('连接成功 · ComfyUI {version} · {gpu}', { version: r.version ?? '', gpu: r.gpu ?? '' }) } : { ok: false, text: r.error ?? t('连接失败') });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    try {
      const r = await api.saveSettings({ comfyUrl: url });
      useStore.setState({ caps: r.capabilities, comfyOnline: r.capabilities.comfyOnline });
      setUrl(r.settings.comfyUrl);
      setSaved(r.settings.comfyUrl);
      setResult(r.capabilities.comfyOnline ? { ok: true, text: t('已保存并连接') } : { ok: false, text: t('已保存，但现在连不上这个地址') });
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const switchLang = async (next: Lang) => {
    rememberLang(next);
    await api.saveSettings({ language: next }).catch(() => {});
    location.reload();
  };

  const saveAgent = async (clearApiKey = false) => {
    setBusy('agent');
    try {
      const r = await api.saveSettings({
        agentModel,
        agentBaseUrl,
        agentVision,
        agentThinking,
        agentApprovalMode,
        agentContextWindow: agentContextWindow.trim() ? Number(agentContextWindow) : null,
        agentReasoning,
        ...(agentApiKey.trim() ? { agentApiKey: agentApiKey.trim() } : {}),
        ...(clearApiKey ? { clearAgentApiKey: true } : {}),
      });
      showAgent(r.settings);
      setAgentApiKey('');
      toast(t('画布助手配置已保存'), 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const agentDirty =
    agentSnapshot({
      comfyUrl: '',
      agentModel,
      agentBaseUrl,
      agentVision,
      agentThinking,
      agentApprovalMode,
      agentContextWindow: Number(agentContextWindow) || undefined,
      agentReasoning,
      agentApiKeyConfigured: agentKeyConfigured || Boolean(agentApiKey),
    }) !== agentSaved;
  /** An OpenAI-compatible endpoint: the app cannot look up its model's context length or whether it reasons. */
  const customAgent = Boolean(agentBaseUrl.trim());

  const builtins = Object.keys(BUILTIN_NAMES);
  return (
    <Modal title={t('设置')} onClose={close}>
      <section className="m-section">
        <div className="m-label">{t('界面语言')}</div>
        <div className="seg">
          {LANGS.map((l) => (
            <button key={l.id} className={l.id === lang ? 'on' : ''} onClick={() => l.id !== lang && void switchLang(l.id)}>
              {l.name}
            </button>
          ))}
        </div>
      </section>

      <section className="m-section">
        <div className="m-label">{t('ComfyUI 地址')}</div>
        <div className="m-row">
          <input
            className="m-input"
            value={url}
            placeholder="http://127.0.0.1:8188"
            spellCheck={false}
            onChange={(e) => {
              setUrl(e.target.value);
              setResult(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
          />
          <button className="btn ghost" onClick={() => void test()} disabled={!url.trim() || busy !== null}>
            {busy === 'test' ? <Loader2 className="spin" /> : null}{t('测试')}
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={!url.trim() || busy !== null || url === saved}>
            {busy === 'save' ? <Loader2 className="spin" /> : null}{t('保存')}
          </button>
        </div>
        {result && <div className={`m-result ${result.ok ? 'ok' : 'bad'}`}>{result.text}</div>}
        <div className="m-help">
          {rich(t('ComfyUI 在本机：填 {0}。在局域网或服务器上：ComfyUI 启动时加 {1} 后填它的地址，或者用 SSH 隧道把端口转到本机（在 {2} 里设置 {3}，{4} 会自动建隧道）。'), [
            <code>http://127.0.0.1:8188</code>,
            <code>--listen</code>,
            <code>.env</code>,
            <code>SSH_HOST</code>,
            <code>npm run dev</code>,
          ])}
        </div>
      </section>

      <section className="m-section">
        <div className="m-label">{t('画布助手模型')}</div>
        <div className="m-help">{t('可接入任意 OpenAI 兼容接口，例如 DeepSeek、OpenRouter、Ollama 或局域网模型。留空则继续使用 .env 配置。')}</div>
        <input className="m-input" value={agentModel} placeholder={t('deepseek/deepseek-flash 或 llama3.1')} spellCheck={false} onChange={(e) => setAgentModel(e.target.value)} />
        <input className="m-input" value={agentBaseUrl} placeholder={t('https://api.deepseek.com/v1（自定义接口地址）')} spellCheck={false} onChange={(e) => setAgentBaseUrl(e.target.value)} />
        <input className="m-input" type="password" value={agentApiKey} placeholder={agentKeyConfigured ? t('API key 已配置，留空保持不变') : t('API key（本地模型可留空）')} autoComplete="off" onChange={(e) => setAgentApiKey(e.target.value)} />
        {customAgent && (
          <>
            <div className="m-row">
              <input className="m-input" type="number" min={16000} step={1024} value={agentContextWindow} placeholder={t('上下文长度（token），留空按 128000')} onChange={(e) => setAgentContextWindow(e.target.value)} />
              <label className="m-check"><input type="checkbox" checked={agentReasoning} onChange={(e) => setAgentReasoning(e.target.checked)} /><span>{t('推理模型')}</span></label>
            </div>
            <div className="m-help">{t('填模型实际的上下文长度：填大了，长对话会在整理摘要前超长报错。勾选「推理模型」才会把思考等级发给它。')}</div>
          </>
        )}
        <div className="m-row">
          <label className="m-check"><input type="checkbox" checked={agentVision} onChange={(e) => setAgentVision(e.target.checked)} /><span>{t('启用视觉输入')}</span></label>
          <label className="m-help">{t('思考')} <select value={agentThinking} disabled={customAgent && !agentReasoning} onChange={(e) => setAgentThinking(e.target.value)}><option value="off">off</option><option value="minimal">minimal</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></label>
        </div>
        <label className="m-help">{t('操作确认')} <select value={agentApprovalMode} onChange={(e) => setAgentApprovalMode(e.target.value as 'risky' | 'always')}><option value="risky">{t('高风险操作确认')}</option><option value="always">{t('所有写入操作确认')}</option></select></label>
        <div className="m-help">{agentApprovalMode === 'always' ? t('助手修改画布、提交生成或运行工作流前都会先等你确认。') : t('视频批量生成等高成本操作会确认，普通操作直接执行。')}</div>
        <div className="m-row">
          <button className="btn primary" onClick={() => void saveAgent()} disabled={!agentDirty || busy !== null}>{busy === 'agent' ? <Loader2 className="spin" /> : null}{t('保存助手配置')}</button>
          {agentKeyConfigured && <button className="btn ghost" onClick={() => void saveAgent(true)} disabled={busy !== null}>{t('清除 API key')}</button>}
        </div>
        <div className="m-help">{t('API key 只保存在本机应用数据中，不会通过设置接口返回。保存后立即对新的助手对话生效。')}</div>
      </section>

      <section className="m-section">
        <div className="m-label">{t('内置工具')}</div>
        <div className="m-help">{t('内置工具会自动在 ComfyUI 里寻找需要的模型（int8 / bf16 / fp8 都可以）。缺模型的工具会显示为不可用。')}</div>
        <div className="tool-list">
          {builtins.map((key) => {
            const missing = caps?.features[key];
            const ok = caps?.comfyOnline && missing && !missing.length;
            // Models to fetch, unless the license setting is what turns the tool off.
            const files = caps?.comfyOnline && !ok && !missing?.some(isBlock) ? (caps.downloads?.[key] ?? []) : [];
            const downloading = files.some((m) => Object.values(downloads).some((j) => activeDownload(j) && j.name === m.name));
            return (
              <div key={key} className="tool-row">
                {ok ? <CheckCircle2 className="ok" /> : <AlertTriangle className="bad" />}
                <span className="tool-name">{BUILTIN_NAMES[key]}</span>
                <span className={`tool-license ${LICENSES[key]?.use ?? ''}`} title={licenseTitle(key, t)}>
                  {licenseLabel(key, t)}
                </span>
                <span className="tool-state" title={!caps?.comfyOnline || ok ? undefined : unavailableReason(missing ?? [])}>
                  {!caps?.comfyOnline ? t('未连接') : ok ? t('可用') : unavailableReason(missing ?? [])}
                </span>
                {files.length > 0 && (
                  <button className="btn ghost small tool-download" onClick={() => openDownloads(files.map((m) => m.name), BUILTIN_NAMES[key])}>
                    {downloading ? <Loader2 className="spin" /> : <Download />} {downloading ? t('下载中') : t('下载模型')}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="m-section">
        <div className="m-label">{t('模型下载')}</div>
        {install && <div className={`dl-mode ${install.mode === 'local' || install.mode === 'ssh' ? 'ok' : 'bad'}`}>{modeLine(install)}</div>}
        <div className="m-row dl-source">
          <span className="m-help">{t('下载源')}</span>
          <SourcePicker value={modelSource} endpoint={modelSource === 'custom' ? 'custom' : install?.endpoint} onChange={pickSource} disabled={busy !== null} />
        </div>
        {modelSource === 'custom' && (
          <div className="m-row">
            <input className="m-input" value={modelEndpoint} placeholder={t('https://hf.example.com（兼容 Hugging Face 的镜像地址）')} spellCheck={false} onChange={(e) => setModelEndpoint(e.target.value)} />
            <button className="btn primary" disabled={!modelEndpoint.trim() || busy !== null} onClick={() => void saveModels({ modelSource: 'custom', modelEndpoint })}>
              {busy === 'models' ? <Loader2 className="spin" /> : null}{t('保存')}
            </button>
          </div>
        )}
        <div className="m-help">{sourceHelp(modelSource, modelEndpoint)}</div>
        <div className="m-row">
          <input
            className="m-input"
            type="password"
            value={hfToken}
            placeholder={install?.hfTokenConfigured ? t('Hugging Face token 已配置，留空保持不变') : t('Hugging Face token（下载需要申请的模型时才用，可留空）')}
            autoComplete="off"
            onChange={(e) => setHfToken(e.target.value)}
          />
          <button className="btn ghost" disabled={!hfToken.trim() || busy !== null} onClick={() => void saveModels({ hfToken })}>{t('保存 token')}</button>
          {install?.hfTokenConfigured && <button className="btn ghost" disabled={busy !== null} onClick={() => void saveModels({ clearHfToken: true })}>{t('清除')}</button>}
        </div>
        <div className="m-row">
          <span className="m-help">{t('缺模型的内置工具和模板可以一键下载；下载会断点续传，中断后重试会接着下载。')}</span>
          <button className="btn ghost" onClick={() => openDownloads([])}>{t('下载记录')}</button>
        </div>
      </section>

      <section className="m-section">
        <div className="m-label">{t('商用')}</div>
        <label className="m-check">
          <input type="checkbox" checked={commercial} disabled={busy !== null} onChange={(e) => void switchCommercial(e.target.checked)} />
          <span>{t('只用可以商用的模型')}</span>
        </label>
        <div className="m-help">
          {t('打开后，只允许研究用途或不能商用的模型会停用：内置的 Qwen-Image 2.1 生图和基于它的局部重绘、消除、扩图、抠图，以及模板库里的 FLUX.2 [dev] 等。出图默认换成 Z-Image Turbo，改图用模板库里标「可商用」的模板（如 Qwen-Image-Edit 2511）。画布助手和 MCP 也遵守这个设置。标注仅供参考，以各模型页面上的许可证原文为准；你自己导入的工作流不受影响。')}
        </div>
      </section>

      <section className="m-section">
        <div className="m-label">{t('我的工作流')}</div>
        <div className="m-row">
          <span className="m-help">{t('已导入 {n} 个。可以把自己在 ComfyUI 里做好的工作流导入成画布上的工具。', { n: workflows.length })}</span>
          <button className="btn ghost" onClick={() => useStore.setState({ modal: { type: 'workflows' } })}>
            {t('管理')}
          </button>
        </div>
      </section>
    </Modal>
  );
}

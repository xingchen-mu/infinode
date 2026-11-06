import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Settings as SettingsIcon, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { AgentStatus, Capabilities, PresetInfo } from '../../shared/types';
import { api } from '../lib/api';
import { Modal } from '../components/Modal';
import { t } from '../i18n';
import { useStore } from '../store';

type CheckState = { caps: Capabilities | null; agent: AgentStatus | null; presets: PresetInfo[]; loading: boolean };

function markSeen() {
  localStorage.setItem('infinode:onboarding', 'done');
}

function StatusIcon({ ok }: { ok: boolean }) {
  return ok ? <CheckCircle2 className="diag-ok" /> : <AlertTriangle className="diag-bad" />;
}

export function OnboardingModal() {
  const [state, setState] = useState<CheckState>({ caps: null, agent: null, presets: [], loading: true });
  const check = async () => {
    setState((s) => ({ ...s, loading: true }));
    const [caps, agent, presets] = await Promise.allSettled([api.capabilities(true), api.agentStatus(), api.presets()]);
    setState({
      caps: caps.status === 'fulfilled' ? caps.value : null,
      agent: agent.status === 'fulfilled' ? agent.value : null,
      presets: presets.status === 'fulfilled' ? presets.value : [],
      loading: false,
    });
  };
  useEffect(() => { void check(); }, []);

  const readyTemplates = useMemo(() => state.presets.filter((preset) => state.caps?.comfyOnline && !state.caps.features[`custom:${preset.id}`]?.length).length, [state.caps, state.presets]);
  const close = () => {
    markSeen();
    useStore.setState({ modal: null });
  };
  const settings = () => {
    markSeen();
    useStore.setState({ modal: { type: 'settings' } });
  };
  const comfyOk = Boolean(state.caps?.comfyOnline);
  const agentOk = Boolean(state.agent?.ready);
  const hasServer = Boolean(state.caps || state.agent);

  return (
    <Modal title={<><Sparkles /> {t('欢迎使用 Infinode')}</>} onClose={close}>
      <div className="onboarding-intro">
        <h2>{t('一张原生 ComfyUI 画布')}</h2>
        <p>{t('节点保存创作过程，助手帮你完成下一步。先检查本机服务和模型连接，之后就可以开始。')}</p>
      </div>
      <section className="diagnostics-grid">
        <div className="diagnostic-card">
          <StatusIcon ok={hasServer} />
          <div><b>{t('本地服务')}</b><small>{hasServer ? t('服务可用') : t('无法连接本地服务')}</small></div>
        </div>
        <div className="diagnostic-card">
          <StatusIcon ok={comfyOk} />
          <div><b>{t('ComfyUI')}</b><small>{comfyOk ? `${state.caps?.gpu ?? t('已连接')} · ${state.caps?.comfyVersion ?? ''}` : t('未连接，可在设置中配置地址')}</small></div>
        </div>
        <div className="diagnostic-card">
          <StatusIcon ok={agentOk} />
          <div><b>{t('画布助手')}</b><small>{agentOk ? state.agent?.model ?? t('已就绪') : state.agent?.reason ?? t('尚未配置模型或 API key')}</small></div>
        </div>
        <div className="diagnostic-card">
          <StatusIcon ok={readyTemplates > 0} />
          <div><b>{t('官方模板')}</b><small>{state.caps?.comfyOnline ? t('已就绪 {n} 个', { n: readyTemplates }) : t('连接 ComfyUI 后检查')}</small></div>
        </div>
      </section>
      <div className="onboarding-help">{t('连接 ComfyUI 后才能生成图片和视频；画布、资产库和节点信息即使离线也可以继续整理。')}</div>
      <div className="m-row onboarding-actions">
        <button className="btn ghost" onClick={() => void check()} disabled={state.loading}>{state.loading ? <Loader2 className="spin" /> : <RefreshCw />} {t('重新检测')}</button>
        <button className="btn ghost" onClick={settings}><SettingsIcon /> {t('打开设置')}</button>
        <button className="btn primary" onClick={close}>{t('开始使用')}</button>
      </div>
    </Modal>
  );
}

import { AlertTriangle, CheckCircle2, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { msg } from '../../shared/i18n';
import { LICENSES, licenseLabel, licenseTitle } from '../../shared/licenses';
import type { PresetInfo } from '../../shared/types';
import { loadWorkflows } from './actions';
import { api } from '../lib/api';
import { missingNote } from '../generation/models';
import { setComposer, toast, useStore } from '../store';
import { rich, t } from '../i18n';
import { Modal } from '../components/Modal';

const close = () => useStore.setState({ modal: null });

// Template categories as the presets store them (Chinese), shown through t().
const ALL = msg('全部');
const CATEGORIES = [ALL, msg('图片生成'), msg('图片编辑'), msg('视频生成'), msg('工具')];
const CATEGORY_KEY = 'infinode:template-category';

function PresetCard({ p }: { p: PresetInfo }) {
  const caps = useStore((s) => s.caps);
  const [open, setOpen] = useState(false);
  const [copying, setCopying] = useState(false);
  const online = caps?.comfyOnline;
  const ready = online && !p.missing.nodes.length && !p.missing.models.length && !p.missing.notes.length;
  const missingCount = p.missing.nodes.length + p.missing.models.length + p.missing.notes.length;

  const use = () => {
    setComposer(p.kind === 'image' ? { mode: 'image', imageModel: `custom:${p.id}` } : { mode: 'video', videoModel: `custom:${p.id}` });
    close();
    requestAnimationFrame(() => document.getElementById('composer-input')?.focus());
  };
  const copy = async () => {
    setCopying(true);
    try {
      const full = await api.preset(p.id);
      const saved = await api.createWorkflow({
        name: t('{name}（我的）', { name: t(p.name) }),
        description: p.description && t(p.description),
        kind: full.kind,
        graph: full.graph,
        inputs: full.inputs,
        outputs: full.outputs,
      });
      await loadWorkflows();
      toast(t('已复制到我的工作流「{name}」，可以修改映射和参数', { name: saved.name }), 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setCopying(false);
    }
  };

  return (
    <div className={`tpl-card ${ready ? '' : 'dim'}`}>
      <div className="tpl-thumb">
        <img src={`/api/presets/${encodeURIComponent(p.id)}/thumb`} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
        <span className="badge">{p.kind === 'video' ? t('视频') : t('图片')}</span>
      </div>
      <div className="tpl-body">
        <div className="tpl-name">{t(p.name)}</div>
        <div className="tpl-desc">{p.description && t(p.description)}</div>
        {LICENSES[`custom:${p.id}`] && (
          <div className={`tpl-license ${LICENSES[`custom:${p.id}`].use}`} title={licenseTitle(`custom:${p.id}`, t)}>
            {LICENSES[`custom:${p.id}`].model} · {licenseLabel(`custom:${p.id}`, t)}
          </div>
        )}
        <div className="tpl-foot">
          {!online ? (
            <span className="tpl-state">{t('ComfyUI 未连接')}</span>
          ) : ready ? (
            <span className="tpl-state ok">
              <CheckCircle2 /> {t('可以直接用')}
            </span>
          ) : (
            <button className="tpl-state bad" onClick={() => setOpen((v) => !v)}>
              <AlertTriangle /> {t('缺少 {n} 项', { n: missingCount })}
              {open ? ' ▴' : ' ▾'}
            </button>
          )}
          <div className="grow" />
          <button className="icon-btn small" title={t('复制到我的工作流（可改参数）')} onClick={() => void copy()} disabled={copying}>
            {copying ? <Loader2 className="spin" /> : <Copy />}
          </button>
          <button className="btn primary small" onClick={use} disabled={!ready}>
            {t('使用')}
          </button>
        </div>
        {open && (
          <div className="tpl-missing">
            {p.missing.notes.map((n) => (
              <div key={n}>{missingNote(n)}</div>
            ))}
            {p.missing.nodes.map((n) => (
              <div key={n}>
                {rich(t('节点 {0}（在 ComfyUI Manager 里安装对应插件，或更新 ComfyUI）'), [<code>{n}</code>])}
              </div>
            ))}
            {p.missing.models.map((m) => (
              <div key={m.name}>
                <code>{m.name}</code>
                {m.directory && <> → <code>models/{m.directory}/</code></>}
                {m.url && (
                  <a href={m.url} target="_blank" rel="noreferrer" title={t('下载')}>
                    <ExternalLink />
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function PresetsModal() {
  const presets = useStore((s) => s.presets);
  const caps = useStore((s) => s.caps);
  // Reopens on the category the user looked at last.
  const [cat, setCat] = useState(() => {
    const saved = localStorage.getItem(CATEGORY_KEY);
    return saved && CATEGORIES.includes(saved) ? saved : ALL;
  });
  const pickCat = (c: string) => {
    setCat(c);
    localStorage.setItem(CATEGORY_KEY, c);
  };
  const [onlyReady, setOnlyReady] = useState(false);
  useEffect(() => void loadWorkflows(), []);
  const isReady = (p: PresetInfo) => caps?.comfyOnline && !p.missing.nodes.length && !p.missing.models.length && !p.missing.notes.length;
  const shown = presets.filter((p) => (cat === ALL || p.category === cat) && (!onlyReady || isReady(p)));
  const readyCount = presets.filter(isReady).length;
  return (
    <Modal
      title={
        <>
          {t('模板库')}
          <span className="m-help title-sub">
            {t('ComfyUI 官方模板 · 当前服务器可直接用 {readyCount} / {n} 个', { readyCount, n: presets.length })}
          </span>
        </>
      }
      onClose={close}
      wide
    >
      <div className="tpl-bar">
        <div className="seg">
          {CATEGORIES.map((c) => (
            <button key={c} className={cat === c ? 'on' : ''} onClick={() => pickCat(c)}>
              {t(c)}
            </button>
          ))}
        </div>
        <label className="out-item">
          <input type="checkbox" checked={onlyReady} onChange={(e) => setOnlyReady(e.target.checked)} /> {t('只看可直接用的')}
        </label>
      </div>
      <div className="tpl-grid">
        {shown.map((p) => (
          <PresetCard key={p.id} p={p} />
        ))}
      </div>
      {!presets.length && <div className="m-help">{t('没有找到模板文件（presets/ 目录）。')}</div>}
      <div className="m-help tpl-note">
        {rich(t('缺少的模型下载后放到 ComfyUI 对应的 {0} 文件夹，重启 ComfyUI 或刷新即可。同名但精度不同（int8 / bf16 / fp8）或放在子文件夹里的模型会自动识别。'), [<code>models/…</code>])}
      </div>
    </Modal>
  );
}

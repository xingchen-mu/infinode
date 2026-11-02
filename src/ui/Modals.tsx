import { AlertTriangle, CheckCircle2, Copy, Download, ExternalLink, FileJson, Loader2, Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { LANGS, type Lang, msg } from '../../shared/i18n';
import { LICENSES, licenseLabel, licenseTitle } from '../../shared/licenses';
import type { CustomWorkflow, PresetInfo, WorkflowDraft, WorkflowField, WorkflowInput, WorkflowInputType } from '../../shared/types';
import { loadWorkflows } from '../lib/actions';
import { type WorkflowData, api } from '../lib/api';
import { missingNote, unavailableReason } from '../lib/models';
import { setComposer, toast, useStore } from '../store';
import { lang, rememberLang, rich, t } from '../i18n';

function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog">
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button className="icon-btn" onClick={onClose} title={t('关闭 (Esc)')}>
            <X />
          </button>
        </div>
        <div className="modal-body" data-scrollable>
          {children}
        </div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

const close = () => useStore.setState({ modal: null });

// ------------------------------------------------------------------ settings

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

function SettingsModal() {
  const caps = useStore((s) => s.caps);
  const workflows = useStore((s) => s.workflows);
  const [url, setUrl] = useState('');
  const [saved, setSaved] = useState('');
  const [commercial, setCommercial] = useState(false);
  const [busy, setBusy] = useState<'test' | 'save' | 'license' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void api.settings().then((s) => {
      setUrl(s.comfyUrl);
      setSaved(s.comfyUrl);
      setCommercial(Boolean(s.commercialOnly));
    });
  }, []);

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
        <div className="m-label">{t('内置工具')}</div>
        <div className="m-help">{t('内置工具会自动在 ComfyUI 里寻找需要的模型（int8 / bf16 / fp8 都可以）。缺模型的工具会显示为不可用。')}</div>
        <div className="tool-list">
          {builtins.map((key) => {
            const missing = caps?.features[key];
            const ok = caps?.comfyOnline && missing && !missing.length;
            return (
              <div key={key} className="tool-row">
                {ok ? <CheckCircle2 className="ok" /> : <AlertTriangle className="bad" />}
                <span className="tool-name">{BUILTIN_NAMES[key]}</span>
                <span className={`tool-license ${LICENSES[key]?.use ?? ''}`} title={licenseTitle(key, t)}>
                  {licenseLabel(key, t)}
                </span>
                <span className="tool-state">{!caps?.comfyOnline ? t('未连接') : ok ? t('可用') : unavailableReason(missing ?? [])}</span>
              </div>
            );
          })}
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

// ------------------------------------------------------------------ workflow list

function inputSummary(wf: CustomWorkflow) {
  const count = (type: WorkflowInputType) => wf.inputs.filter((i) => i.type === type).length;
  const parts: string[] = [];
  if (count('prompt')) parts.push(t('提示词'));
  if (count('image')) parts.push(t('{n} 张图', { n: count('image') }));
  if (count('video')) parts.push(t('{n} 个视频', { n: count('video') }));
  if (count('mask')) parts.push(t('蒙版'));
  const params = wf.inputs.filter((i) => ['number', 'text', 'select', 'boolean'].includes(i.type)).length;
  if (params) parts.push(t('{n} 个参数', { n: params }));
  return parts.join(' · ') || t('无输入');
}

function exportWorkflow(wf: CustomWorkflow) {
  const data = { format: 'infinode/workflow', version: 1, name: wf.name, description: wf.description, kind: wf.kind, graph: wf.graph, inputs: wf.inputs, outputs: wf.outputs };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${wf.name.replace(/[\\/:*?"<>|]+/g, '_')}.infinode.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importFile(file: File) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    toast(t('{name} 不是有效的 JSON', { name: file.name }), 'error');
    return;
  }
  try {
    const draft = await api.draftWorkflow(parsed, file.name);
    useStore.setState({ modal: { type: 'editor', draft } });
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

function WorkflowsModal() {
  const workflows = useStore((s) => s.workflows);
  const caps = useStore((s) => s.caps);
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const edit = async (wf: CustomWorkflow) => {
    try {
      useStore.setState({ modal: { type: 'editor', draft: await api.workflowDraft(wf.id), id: wf.id } });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const remove = async (wf: CustomWorkflow) => {
    if (!confirm(t('删除工作流「{name}」？画布上已经生成的内容不受影响。', { name: t(wf.name) }))) return;
    await api.deleteWorkflow(wf.id);
    await loadWorkflows();
  };
  const use = (wf: CustomWorkflow) => {
    setComposer(wf.kind === 'image' ? { mode: 'image', imageModel: `custom:${wf.id}` } : { mode: 'video', videoModel: `custom:${wf.id}` });
    close();
    requestAnimationFrame(() => document.getElementById('composer-input')?.focus());
  };

  return (
    <Modal
      title={t('我的工作流')}
      onClose={close}
      wide
      footer={
        <>
          <span className="m-help">{t('支持 ComfyUI「导出 (API)」的 JSON，和这里导出的 .infinode.json')}</span>
          <button className="btn primary" onClick={() => input.current?.click()}>
            <Upload /> {t('导入工作流')}
          </button>
        </>
      }
    >
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void importFile(f);
        }}
      />
      <div
        className={`wf-drop ${dragging ? 'on' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f) void importFile(f);
        }}
        onClick={() => input.current?.click()}
      >
        <FileJson />
        <div>
          <b>{t('把工作流 JSON 拖到这里')}</b>{t('，或点击选择文件')}
          <small>{t('在 ComfyUI 中打开工作流 → 菜单「工作流 / Workflow」→「导出 (API) / Export (API)」')}</small>
        </div>
      </div>

      {workflows.length === 0 ? (
        <div className="m-help wf-empty">
          {t('还没有导入的工作流。导入后会出现在底部输入框的模型列表里，选中画布上的图片即可作为它的输入。')}
          <br />
          {rich(t('小技巧：在 ComfyUI 里把节点标题改成 {0}、{1}、{2}、{3}、{4}、{5}，导入时会按标题识别。'), [
            <code>@prompt</code>,
            <code>@image</code>,
            <code>{t('@image:人物')}</code>,
            <code>@negative</code>,
            <code>@seed</code>,
            <code>@output</code>,
          ])}
        </div>
      ) : (
        <div className="wf-list">
          {workflows.map((wf) => {
            const missing = caps?.features[`custom:${wf.id}`];
            const bad = caps?.comfyOnline && missing && missing.length > 0;
            return (
              <div key={wf.id} className="wf-row">
                <div className="wf-main">
                  <div className="wf-name">
                    {t(wf.name)}
                    <span className="badge">{wf.kind === 'video' ? t('视频') : t('图片')}</span>
                  </div>
                  <div className="wf-meta">{inputSummary(wf)}</div>
                  {bad && <div className="wf-bad">{unavailableReason(missing!)}</div>}
                </div>
                <button className="btn ghost small" onClick={() => use(wf)} disabled={Boolean(bad)}>
                  {t('使用')}
                </button>
                <button className="icon-btn" title={t('编辑映射')} onClick={() => void edit(wf)}>
                  <Pencil />
                </button>
                <button className="icon-btn" title={t('导出分享')} onClick={() => exportWorkflow(wf)}>
                  <Download />
                </button>
                <button className="icon-btn danger" title={t('删除')} onClick={() => void remove(wf)}>
                  <Trash2 />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ mapping editor

const TYPE_LABELS: Record<WorkflowInputType, string> = {
  prompt: t('提示词'),
  negative: t('反向提示词'),
  image: t('图片输入'),
  video: t('视频输入'),
  mask: t('蒙版'),
  seed: t('随机种子'),
  width: t('宽度'),
  height: t('高度'),
  aspect: t('画面比例'),
  number: t('数值参数'),
  text: t('文本参数'),
  select: t('选项参数'),
  boolean: t('开关参数'),
};
const PARAM_TYPES: WorkflowInputType[] = ['number', 'text', 'select', 'boolean'];

function fieldKey(node: string, field: string) {
  return `${node}\u0000${field}`;
}

function uniqueId(base: string, taken: Set<string>) {
  const clean = base.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '') || 'p';
  let id = clean;
  for (let n = 2; taken.has(id); n++) id = `${clean}_${n}`;
  return id;
}

function InputRow({
  inp,
  field,
  graphTitle,
  onChange,
  onRemove,
}: {
  inp: WorkflowInput;
  field?: WorkflowField;
  graphTitle: string;
  onChange: (next: WorkflowInput) => void;
  onRemove: () => void;
}) {
  const isParam = PARAM_TYPES.includes(inp.type);
  const types: WorkflowInputType[] =
    inp.type === 'image' || inp.type === 'video' || inp.type === 'mask'
      ? ['image', 'video', 'mask']
      : field?.kind === 'number'
        ? ['number', 'seed', 'width', 'height']
        : field?.kind === 'select'
          ? ['select', 'aspect', 'text']
          : field?.kind === 'boolean'
            ? ['boolean']
            : ['prompt', 'negative', 'text'];
  return (
    <div className={`map-row ${isParam ? 'param' : ''}`}>
      <select className="map-type" value={inp.type} onChange={(e) => onChange({ ...inp, type: e.target.value as WorkflowInputType, options: inp.options ?? field?.options })}>
        {(types.includes(inp.type) ? types : [inp.type, ...types]).map((type) => (
          <option key={type} value={type}>
            {TYPE_LABELS[type]}
          </option>
        ))}
      </select>
      <input className="map-label" value={t(inp.label)} onChange={(e) => onChange({ ...inp, label: e.target.value })} title={t('在画布上显示的名称')} />
      <span className="map-bind" title={t('节点 #{node} {graphTitle} 的 {field} 字段', { node: inp.node, graphTitle, field: inp.field })}>
        #{inp.node} {graphTitle}.<b>{inp.field}</b>
      </span>
      {isParam && (
        <span className="map-default">
          {t('默认')}
          {inp.type === 'boolean' ? (
            <input type="checkbox" checked={Boolean(inp.default)} onChange={(e) => onChange({ ...inp, default: e.target.checked })} />
          ) : inp.type === 'select' ? (
            <select value={String(inp.default ?? '')} onChange={(e) => onChange({ ...inp, default: e.target.value })}>
              {(inp.options ?? field?.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={inp.type === 'number' ? 'number' : 'text'}
              value={inp.default === undefined ? '' : String(inp.default)}
              onChange={(e) => onChange({ ...inp, default: inp.type === 'number' ? Number(e.target.value) : e.target.value })}
            />
          )}
        </span>
      )}
      <button className="icon-btn small danger" title={t('不再暴露这个字段')} onClick={onRemove}>
        <Trash2 />
      </button>
    </div>
  );
}

function WorkflowEditor({ draft, id }: { draft: WorkflowDraft; id?: string }) {
  const [wf, setWf] = useState<WorkflowData>(() => ({
    name: draft.workflow.name,
    description: draft.workflow.description,
    kind: draft.workflow.kind,
    graph: draft.workflow.graph,
    inputs: draft.workflow.inputs,
    outputs: draft.workflow.outputs,
  }));
  const [issues, setIssues] = useState(draft.issues);
  const [adding, setAdding] = useState('');
  const [saving, setSaving] = useState(false);
  const fields = useMemo(() => new Map(draft.fields.map((f) => [fieldKey(f.node, f.field), f])), [draft.fields]);
  const used = new Set(wf.inputs.map((i) => fieldKey(i.node, i.field)));
  const titleOf = (node: string) => {
    const n = wf.graph[node];
    return n ? (n._meta?.title && !n._meta.title.startsWith('@') ? n._meta.title : n.class_type) : '?';
  };

  const setInput = (i: number, next: WorkflowInput) => setWf((w) => ({ ...w, inputs: w.inputs.map((x, j) => (j === i ? next : x)) }));
  const removeInput = (i: number) => setWf((w) => ({ ...w, inputs: w.inputs.filter((_, j) => j !== i) }));

  const addField = (key: string) => {
    const f = fields.get(key);
    if (!f) return;
    const loader = f.classType === 'LoadImage' && f.field === 'image';
    const type: WorkflowInputType = loader ? 'image' : f.kind === 'select' ? 'select' : f.kind === 'number' ? 'number' : f.kind === 'boolean' ? 'boolean' : 'text';
    const taken = new Set(wf.inputs.map((i) => i.id));
    setWf((w) => ({
      ...w,
      inputs: [
        ...w.inputs,
        {
          id: uniqueId(loader ? `image${w.inputs.filter((i) => i.type === 'image').length + 1}` : f.field, taken),
          type,
          node: f.node,
          field: f.field,
          label: loader ? `${msg('图')}${w.inputs.filter((i) => i.type === 'image').length + 1}` : f.field,
          ...(loader ? {} : { default: f.value as string | number | boolean }),
          ...(f.options ? { options: f.options } : {}),
          ...(f.kind === 'number' ? { min: f.min, max: f.max, step: f.step } : {}),
        },
      ],
    }));
    setAdding('');
  };

  /** Swap a missing model/file for one the server has. */
  const replaceValue = (node: string, field: string, value: string) => {
    setWf((w) => ({ ...w, graph: { ...w.graph, [node]: { ...w.graph[node], inputs: { ...w.graph[node].inputs, [field]: value } } } }));
    setIssues((list) => list.filter((x) => !(x.node === node && x.field === field)));
  };

  const save = async () => {
    setSaving(true);
    try {
      const saved = id ? await api.updateWorkflow(id, wf) : await api.createWorkflow(wf);
      await loadWorkflows();
      toast(id ? t('已保存') : t('已导入「{name}」，可以在输入框的模型列表里选择它', { name: saved.name }), 'success');
      if (!id) setComposer(saved.kind === 'image' ? { mode: 'image', imageModel: `custom:${saved.id}` } : { mode: 'video', videoModel: `custom:${saved.id}` });
      useStore.setState({ modal: { type: 'workflows' } });
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const addable = draft.fields.filter((f) => !used.has(fieldKey(f.node, f.field)));
  const ordered = wf.inputs.map((inp, i) => ({ inp, i }));
  const typeOrder: WorkflowInputType[] = ['prompt', 'negative', 'image', 'video', 'mask', 'aspect', 'width', 'height', 'seed', 'number', 'select', 'text', 'boolean'];
  ordered.sort((a, b) => typeOrder.indexOf(a.inp.type) - typeOrder.indexOf(b.inp.type) || a.i - b.i);

  return (
    <Modal
      title={id ? t('编辑工作流') : t('导入工作流')}
      onClose={() => useStore.setState({ modal: { type: 'workflows' } })}
      wide
      footer={
        <>
          <button className="btn ghost" onClick={() => useStore.setState({ modal: { type: 'workflows' } })}>
            {t('取消')}
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={saving || !wf.name.trim() || !wf.outputs.length}>
            {saving ? <Loader2 className="spin" /> : null}
            {id ? t('保存') : t('导入')}
          </button>
        </>
      }
    >
      <section className="m-section">
        <div className="m-row">
          <input className="m-input" placeholder={t('名称，例如：Flux 人像')} value={wf.name} onChange={(e) => setWf({ ...wf, name: e.target.value })} />
          <div className="seg">
            <button className={wf.kind === 'image' ? 'on' : ''} onClick={() => setWf({ ...wf, kind: 'image' })}>
              {t('输出图片')}
            </button>
            <button className={wf.kind === 'video' ? 'on' : ''} onClick={() => setWf({ ...wf, kind: 'video' })}>
              {t('输出视频')}
            </button>
          </div>
        </div>
        <input
          className="m-input"
          placeholder={t('一句话说明（可选），会显示在模型列表里')}
          value={wf.description ?? ''}
          onChange={(e) => setWf({ ...wf, description: e.target.value })}
        />
      </section>

      {issues.length > 0 && (
        <section className="m-section issues">
          {issues.map((iss, k) => (
            <div key={k} className={`issue ${iss.type === 'auto' ? 'auto' : ''}`}>
              <AlertTriangle />
              <span>{iss.message}</span>
              {iss.type === 'file' && iss.options && iss.node && iss.field && (
                <select defaultValue="" onChange={(e) => e.target.value && replaceValue(iss.node!, iss.field!, e.target.value)}>
                  <option value="">{t('换成服务器上的文件…')}</option>
                  {iss.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="m-section">
        <div className="m-label">
          {t('输入映射')}
          <span className="m-help">{t('自动识别的结果，画布会把这些值填进对应节点。不对的可以改类型或删除。')}</span>
        </div>
        <div className="map-list">
          {ordered.map(({ inp, i }) => (
            <InputRow
              key={`${inp.node}-${inp.field}-${i}`}
              inp={inp}
              field={fields.get(fieldKey(inp.node, inp.field))}
              graphTitle={titleOf(inp.node)}
              onChange={(next) => setInput(i, next)}
              onRemove={() => removeInput(i)}
            />
          ))}
          {!wf.inputs.length && <div className="m-help">{t('没有识别到输入。可以在下面添加。')}</div>}
        </div>
        <div className="m-row add-row">
          <Plus />
          <select value={adding} onChange={(e) => addField(e.target.value)}>
            <option value="">{t('添加参数：选择要在画布上调节的节点字段…')}</option>
            {addable.map((f) => (
              <option key={fieldKey(f.node, f.field)} value={fieldKey(f.node, f.field)}>
                #{f.node} {f.title && !f.title.startsWith('@') ? f.title : f.classType} · {f.field} = {String(f.value).slice(0, 40)}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="m-section">
        <div className="m-label">
          {t('输出节点')}
          <span className="m-help">{t('这些节点保存的图片 / 视频会放到画布上')}</span>
        </div>
        <div className="out-list">
          {draft.outputCandidates.map((c) => (
            <label key={c.node} className="out-item">
              <input
                type="checkbox"
                checked={wf.outputs.includes(c.node)}
                onChange={(e) =>
                  setWf((w) => ({ ...w, outputs: e.target.checked ? [...w.outputs, c.node] : w.outputs.filter((o) => o !== c.node) }))
                }
              />
              #{c.node} {c.title && !c.title.startsWith('@') ? c.title : c.classType}
            </label>
          ))}
          {!draft.outputCandidates.length && <div className="m-help">{t('工作流里没有保存图片或视频的节点（SaveImage / SaveVideo / VHS_VideoCombine …）')}</div>}
        </div>
      </section>
    </Modal>
  );
}

// ------------------------------------------------------------------ template gallery

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

function PresetsModal() {
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

export function Modals() {
  const modal = useStore((s) => s.modal);
  if (!modal) return null;
  if (modal.type === 'settings') return <SettingsModal />;
  if (modal.type === 'workflows') return <WorkflowsModal />;
  if (modal.type === 'presets') return <PresetsModal />;
  return <WorkflowEditor key={modal.id ?? 'new'} draft={modal.draft} id={modal.id} />;
}

import { AlertTriangle, Loader2, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { msg } from '../../shared/i18n';
import type { WorkflowDraft, WorkflowField, WorkflowInput, WorkflowInputType } from '../../shared/types';
import { loadWorkflows } from './actions';
import { type WorkflowData, api } from '../lib/api';
import { setComposer, toast, useStore } from '../store';
import { t } from '../i18n';
import { Modal } from '../components/Modal';

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

export function WorkflowEditor({ draft, id }: { draft: WorkflowDraft; id?: string }) {
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

import { Download, FileJson, Pencil, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import type { CustomWorkflow, WorkflowInputType } from '../../shared/types';
import { loadWorkflows } from './actions';
import { api } from '../lib/api';
import { unavailableReason } from '../generation/models';
import { setComposer, toast, useStore } from '../store';
import { rich, t } from '../i18n';
import { Modal } from '../components/Modal';

const close = () => useStore.setState({ modal: null });

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

export function WorkflowsModal() {
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

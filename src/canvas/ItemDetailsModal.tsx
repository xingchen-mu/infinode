import { Check, Clipboard, GitBranch, Link2, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { CanvasItem, TaskRequest } from '../../shared/types';
import { inputIds } from './items';
import { Modal } from '../components/Modal';
import { select, toast, useStore } from '../store';
import { t } from '../i18n';

function operation(request: TaskRequest): string {
  switch (request.op) {
    case 'image.generate': return request.images?.length ? t('参考图生成') : t('文生图');
    case 'video.generate': return t('生成视频');
    case 'image.inpaint': return t('局部重绘');
    case 'image.erase': return t('消除');
    case 'image.outpaint': return t('扩图');
    case 'image.removeBg': return t('抠图');
    case 'image.upscale': return t('{scale} 倍超清', { scale: request.scale });
    case 'custom': return t('运行工作流');
  }
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast(t('已复制'), 'success');
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      toast(t('复制失败，请手动选择文本'), 'error');
    }
  };
  return <button className="btn ghost small" onClick={() => void copy()}>{copied ? <Check /> : <Clipboard />} {copied ? t('已复制') : label}</button>;
}

function requestRows(request: TaskRequest): [string, string][] {
  const rows: [string, string][] = [[t('操作'), operation(request)]];
  if (request.op === 'image.generate' || request.op === 'video.generate') rows.push([t('模型'), request.model]);
  if ('aspect' in request && request.aspect) rows.push([t('画面比例'), request.aspect]);
  if ('quality' in request && request.quality) rows.push([t('质量'), request.quality]);
  if (request.op === 'video.generate') rows.push([t('时长'), t('{n} 秒', { n: request.duration })]);
  return rows;
}

export function ItemDetailsModal({ itemId }: { itemId: string }) {
  const item = useStore((s) => s.items.find((i) => i.id === itemId));
  const allItems = useStore((s) => s.items);
  const workflows = useStore((s) => s.workflows);
  const presets = useStore((s) => s.presets);
  const close = () => useStore.setState({ modal: null });
  const request = item?.request;
  const inputs = useMemo(() => (item ? inputIds(item).map((id) => allItems.find((x) => x.id === id)).filter((x): x is CanvasItem => Boolean(x)) : []), [allItems, item]);
  const workflow = request?.op === 'custom' ? workflows.find((w) => w.id === request.workflow) ?? presets.find((w) => w.id === request.workflow) : undefined;
  if (!item) return null;

  return (
    <Modal title={t('节点信息')} onClose={close} wide>
      <section className="m-section">
        <div className="m-label"><Sparkles /> {item.name || t('未命名节点')}</div>
        <div className="detail-rows">
          <div className="lb-row"><span>{t('节点 ID')}</span><code>{item.id}</code></div>
          <div className="lb-row"><span>{t('类型')}</span><span>{item.kind === 'text' ? t('文本') : item.kind === 'image' ? t('图片') : t('视频')}</span></div>
          {item.asset && <div className="lb-row"><span>{t('尺寸')}</span><span>{item.asset.width} × {item.asset.height}</span></div>}
          {item.taskId && <div className="lb-row"><span>{t('任务')}</span><code>{item.taskId}</code></div>}
        </div>
      </section>

      {inputs.length > 0 && (
        <section className="m-section">
          <div className="m-label"><Link2 /> {t('输入链路')}</div>
          <div className="detail-lineage">
            {inputs.map((input) => <button key={input.id} className="chip" onClick={() => { select([input.id]); close(); }}>{input.name || input.id}</button>)}
          </div>
          <div className="m-help">{t('这些节点是生成当前结果时使用的输入。')}</div>
        </section>
      )}

      {request && (
        <section className="m-section">
          <div className="m-label"><GitBranch /> {t('生成来源')}</div>
          <div className="detail-rows">
            {requestRows(request).map(([key, value]) => <div className="lb-row" key={key}><span>{key}</span><span>{value}</span></div>)}
            {workflow && <div className="lb-row"><span>{t('工作流')}</span><span>{workflow.name}</span></div>}
          </div>
          {'prompt' in request && request.prompt && <div className="detail-prompt">{request.prompt}</div>}
          <div className="m-row">
            <CopyButton value={JSON.stringify(request, null, 2)} label={t('复制请求 JSON')} />
            {workflow && 'graph' in workflow && <CopyButton value={JSON.stringify(workflow.graph, null, 2)} label={t('复制 ComfyUI 图谱')} />}
          </div>
        </section>
      )}

      {!request && item.kind === 'text' && <section className="m-section"><div className="m-label">{t('文本内容')}</div><div className="detail-prompt">{item.text || t('空文本')}</div></section>}
    </Modal>
  );
}

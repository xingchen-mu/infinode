import { Hand, HelpCircle, ImagePlus, MousePointer2, Scan, StickyNote, Workflow } from 'lucide-react';
import { useRef, useState } from 'react';
import { addFiles } from '../assets/actions';
import { addNote } from './items';
import { fitAll } from './view';
import { setShowLinks, useStore } from '../store';
import { t } from '../i18n';

const SHORTCUTS: [string, string][] = [
  [t('双指滑动 / 滚轮'), t('平移画布')],
  [t('双指捏合 / ⌘ + 滚轮'), t('缩放')],
  [t('空格 + 拖动'), t('临时抓手')],
  ['V / H', t('选择 / 抓手')],
  [t('⇧ + 点击'), t('多选')],
  [t('双击图片'), t('全屏预览')],
  [t('双击文本'), t('编辑文本')],
  ['⌘Z / ⇧⌘Z', t('撤销 / 重做')],
  ['⌘C ⌘V / ⌘D', t('复制粘贴 / 复制一份')],
  ['Delete', t('删除')],
  ['⇧1', t('显示全部')],
  [t('拖动图片右侧 +'), t('拉出连线，在终点生成')],
  ['L', t('显示 / 隐藏连线')],
  ['/', t('聚焦输入框')],
  ['Enter', t('生成（⇧Enter 换行）')],
  ['[ / ]', t('调整笔刷大小')],
];

export function LeftToolbar() {
  const tool = useStore((s) => s.tool);
  const showLinks = useStore((s) => s.showLinks);
  const input = useRef<HTMLInputElement>(null);
  const [help, setHelp] = useState(false);
  return (
    <div className="leftbar" data-ui>
      <button className={`tool ${tool === 'select' ? 'on' : ''}`} title={t('选择 (V)')} onClick={() => useStore.setState({ tool: 'select' })}>
        <MousePointer2 />
      </button>
      <button className={`tool ${tool === 'hand' ? 'on' : ''}`} title={t('抓手 (H)')} onClick={() => useStore.setState({ tool: 'hand' })}>
        <Hand />
      </button>
      <div className="tool-sep" />
      <button className="tool" title={t('上传图片或视频')} onClick={() => input.current?.click()}>
        <ImagePlus />
      </button>
      <button className="tool" title={t('添加文本（剧本、分镜、备注）')} onClick={addNote}>
        <StickyNote />
      </button>
      <button className="tool" title={t('显示全部 (⇧1)')} onClick={fitAll}>
        <Scan />
      </button>
      <button className={`tool ${showLinks ? 'on-soft' : ''}`} title={showLinks ? t('隐藏连线 (L)') : t('显示连线 (L)')} onClick={() => setShowLinks(!showLinks)}>
        <Workflow />
      </button>
      <div className="tool-sep" />
      <button className={`tool ${help ? 'on' : ''}`} title={t('快捷键')} onClick={() => setHelp((v) => !v)}>
        <HelpCircle />
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          void addFiles(files);
        }}
      />
      {help && (
        <div className="help-pop">
          <div className="help-title">{t('快捷操作')}</div>
          {SHORTCUTS.map(([k, v]) => (
            <div key={k} className="help-row">
              <kbd>{k}</kbd>
              <span>{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

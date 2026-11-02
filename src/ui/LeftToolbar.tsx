import { Hand, HelpCircle, ImagePlus, MousePointer2, Scan, StickyNote, Workflow } from 'lucide-react';
import { useRef, useState } from 'react';
import { addFiles, addNote, fitAll } from '../lib/actions';
import { setShowLinks, useStore } from '../store';

const SHORTCUTS: [string, string][] = [
  ['双指滑动 / 滚轮', '平移画布'],
  ['双指捏合 / ⌘ + 滚轮', '缩放'],
  ['空格 + 拖动', '临时抓手'],
  ['V / H', '选择 / 抓手'],
  ['⇧ + 点击', '多选'],
  ['双击图片', '全屏预览'],
  ['双击文本', '编辑文本'],
  ['⌘Z / ⇧⌘Z', '撤销 / 重做'],
  ['⌘C ⌘V / ⌘D', '复制粘贴 / 复制一份'],
  ['Delete', '删除'],
  ['⇧1', '显示全部'],
  ['拖动图片右侧 +', '拉出连线，在终点生成'],
  ['L', '显示 / 隐藏连线'],
  ['/', '聚焦输入框'],
  ['Enter', '生成（⇧Enter 换行）'],
  ['[ / ]', '调整笔刷大小'],
];

export function LeftToolbar() {
  const tool = useStore((s) => s.tool);
  const showLinks = useStore((s) => s.showLinks);
  const input = useRef<HTMLInputElement>(null);
  const [help, setHelp] = useState(false);
  return (
    <div className="leftbar" data-ui>
      <button className={`tool ${tool === 'select' ? 'on' : ''}`} title="选择 (V)" onClick={() => useStore.setState({ tool: 'select' })}>
        <MousePointer2 />
      </button>
      <button className={`tool ${tool === 'hand' ? 'on' : ''}`} title="抓手 (H)" onClick={() => useStore.setState({ tool: 'hand' })}>
        <Hand />
      </button>
      <div className="tool-sep" />
      <button className="tool" title="上传图片或视频" onClick={() => input.current?.click()}>
        <ImagePlus />
      </button>
      <button className="tool" title="添加文本（剧本、分镜、备注）" onClick={addNote}>
        <StickyNote />
      </button>
      <button className="tool" title="显示全部 (⇧1)" onClick={fitAll}>
        <Scan />
      </button>
      <button className={`tool ${showLinks ? 'on-soft' : ''}`} title={showLinks ? '隐藏连线 (L)' : '显示连线 (L)'} onClick={() => setShowLinks(!showLinks)}>
        <Workflow />
      </button>
      <div className="tool-sep" />
      <button className={`tool ${help ? 'on' : ''}`} title="快捷键" onClick={() => setHelp((v) => !v)}>
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
          <div className="help-title">快捷操作</div>
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

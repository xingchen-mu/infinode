import { ArrowDownToLine, ArrowUpToLine, ClipboardPaste, Copy, Download, Eye, ImagePlus, Info, Scan, Trash2 } from 'lucide-react';
import { useEffect } from 'react';
import { addFiles, download } from '../assets/actions';
import { duplicate, reorder } from './items';
import { fitAll } from './view';
import { pasteInternal, hasInternalClipboard } from './clipboard';
import { removeItems, useStore } from '../store';
import { t } from '../i18n';

export interface MenuState {
  x: number;
  y: number;
  itemId?: string;
  world: { x: number; y: number };
}

export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const selection = useStore((s) => s.selection);
  const item = useStore((s) => s.items.find((i) => i.id === menu.itemId));
  const screen = useStore((s) => s.screen);
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const left = Math.min(menu.x, screen.w - 200);
  const top = Math.min(menu.y, screen.h - 260);
  const ids = selection.length ? selection : item ? [item.id] : [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', onClose, { passive: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', onClose);
    };
  }, [onClose]);

  return (
    <div className="menu ctx" data-ui style={{ left, top }} onPointerDown={(e) => e.stopPropagation()}>
      {item ? (
        <>
          {item.asset && (
            <button className="menu-item" onClick={run(() => useStore.setState({ lightboxId: item.id }))}>
              <Eye /> {t('预览')}
            </button>
          )}
          <button className="menu-item" onClick={run(() => useStore.setState({ modal: { type: 'details', itemId: item.id } }))}>
            <Info /> {t('节点信息')}
          </button>
          {item.asset && (
            <button className="menu-item" onClick={run(() => download(item))}>
              <Download /> {t('下载')}
            </button>
          )}
          <button className="menu-item" onClick={run(() => duplicate(ids))}>
            <Copy /> {t('复制一份')} <kbd>⌘D</kbd>
          </button>
          <div className="menu-sep" />
          <button className="menu-item" onClick={run(() => reorder(ids, 'front'))}>
            <ArrowUpToLine /> {t('置于顶层')}
          </button>
          <button className="menu-item" onClick={run(() => reorder(ids, 'back'))}>
            <ArrowDownToLine /> {t('置于底层')}
          </button>
          <div className="menu-sep" />
          <button className="menu-item danger" onClick={run(() => removeItems(ids))}>
            <Trash2 /> {t('删除')} <kbd>⌫</kbd>
          </button>
        </>
      ) : (
        <>
          {hasInternalClipboard() && (
            <button className="menu-item" onClick={run(() => pasteInternal(menu.world))}>
              <ClipboardPaste /> {t('粘贴')} <kbd>⌘V</kbd>
            </button>
          )}
          <button
            className="menu-item"
            onClick={run(() => {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = 'image/*,video/*';
              input.multiple = true;
              input.onchange = () => void addFiles([...(input.files ?? [])], menu.world);
              input.click();
            })}
          >
            <ImagePlus /> {t('上传到这里')}
          </button>
          <button className="menu-item" onClick={run(fitAll)}>
            <Scan /> {t('显示全部')} <kbd>⇧1</kbd>
          </button>
        </>
      )}
    </div>
  );
}

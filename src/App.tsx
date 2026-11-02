import { useEffect } from 'react';
import { Canvas } from './canvas/Canvas';
import { MaskPanel, resizeBrush, undoStroke, useMask } from './editors/MaskEditor';
import { OutpaintPanel } from './editors/OutpaintEditor';
import { addFiles, duplicate, fitAll, loadWorkflows } from './lib/actions';
import { api, subscribeEvents } from './lib/api';
import { CLIP_MARKER, copySelection, hasInternalClipboard, pasteInternal } from './lib/clipboard';
import { bootstrap, flushSave, onProjectEvent, refreshProject, setupAutosave, syncTasks } from './project';
import { applyTask, redo, removeItems, select, setShowLinks, toast, undo, updateItems, useStore, zoomAt } from './store';
import { AgentPanel, onAgentEvent, refreshAgent } from './ui/AgentPanel';
import { Composer } from './ui/Composer';
import { LeftToolbar } from './ui/LeftToolbar';
import { Lightbox } from './ui/Lightbox';
import { Modals } from './ui/Modals';
import { TopBar } from './ui/TopBar';

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

async function refreshCaps(force = false) {
  try {
    const caps = await api.capabilities(force);
    useStore.setState({ caps, comfyOnline: caps.comfyOnline });
  } catch {
    /* server offline */
  }
}

function isTyping(target: EventTarget | null) {
  return Boolean((target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]'));
}

function onKeyDown(e: KeyboardEvent) {
  const st = useStore.getState();
  if (st.modal || st.lightboxId) return; // dialogs handle their own keys
  const typing = isTyping(e.target);
  if (e.code === 'Space' && !typing) {
    e.preventDefault();
    if (!st.spaceHeld) useStore.setState({ spaceHeld: true });
    return;
  }
  if (typing) {
    if (e.key === 'Escape') (e.target as HTMLElement).blur();
    return;
  }
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  const { w, h } = st.screen;

  if (st.editing) {
    if (e.key === 'Escape') useStore.setState({ editing: null });
    else if (mod && key === 'z') {
      e.preventDefault();
      undoStroke();
    } else if (e.key === '[') resizeBrush(-1);
    else if (e.key === ']') resizeBrush(1);
    else if (key === 'b') useMask.setState({ erasing: false });
    else if (key === 'e') useMask.setState({ erasing: true });
    return;
  }

  if (mod && key === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if (mod && key === 'y') {
    e.preventDefault();
    redo();
  } else if (mod && key === 'a') {
    e.preventDefault();
    select(st.items.map((i) => i.id));
  } else if (mod && key === 'd') {
    e.preventDefault();
    duplicate(st.selection);
  } else if (mod && key === 'c') {
    copySelection();
  } else if (mod && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    zoomAt(w / 2, h / 2, st.viewport.zoom * 1.25);
  } else if (mod && e.key === '-') {
    e.preventDefault();
    zoomAt(w / 2, h / 2, st.viewport.zoom / 1.25);
  } else if (mod && e.key === '0') {
    e.preventDefault();
    zoomAt(w / 2, h / 2, 1);
  } else if (e.shiftKey && e.code === 'Digit1') {
    fitAll();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (st.selection.length) {
      e.preventDefault();
      removeItems(st.selection);
    }
  } else if (e.key === 'Escape') {
    if (st.pendingOutput) useStore.setState({ pendingOutput: null });
    else select([]);
  } else if (!mod && key === 'v') {
    useStore.setState({ tool: 'select' });
  } else if (!mod && key === 'h') {
    useStore.setState({ tool: 'hand' });
  } else if (!mod && key === 'l') {
    setShowLinks(!st.showLinks);
  } else if (e.key.startsWith('Arrow') && st.selection.length) {
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
    const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
    updateItems((items) => items.map((i) => (st.selection.includes(i.id) ? { ...i, x: i.x + dx, y: i.y + dy } : i)));
  }
}

function onKeyUp(e: KeyboardEvent) {
  if (e.code === 'Space') useStore.setState({ spaceHeld: false });
}

function onPaste(e: ClipboardEvent) {
  if (useStore.getState().modal) return;
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => /^(image|video)\//.test(f.type));
  if (files.length) {
    e.preventDefault();
    void addFiles(files);
    return;
  }
  if (isTyping(e.target)) return;
  const text = e.clipboardData?.getData('text/plain');
  if (hasInternalClipboard() && (!text || text === CLIP_MARKER)) {
    e.preventDefault();
    pasteInternal();
  }
}

export function App() {
  useEffect(() => {
    const stopAutosave = setupAutosave();
    bootstrap().catch((err) => toast(`加载画布失败：${(err as Error).message}`, 'error'));
    void loadWorkflows();
    void refreshCaps();
    const capsTimer = setInterval(() => void refreshCaps(), 60_000);
    let wasConnected = true;
    const stopEvents = subscribeEvents({
      onTask: applyTask,
      onProject: onProjectEvent,
      onAgent: onAgentEvent,
      onComfy: (online) => {
        useStore.setState({ comfyOnline: online });
        if (online) void refreshCaps(true);
      },
      onHello: ({ comfyOnline, active }) => {
        useStore.setState({ comfyOnline });
        active.forEach(applyTask);
        void syncTasks();
        refreshProject();
        void refreshAgent();
      },
      onConnection: (ok) => {
        useStore.setState({ serverOnline: ok });
        if (ok && !wasConnected) void refreshCaps(true);
        wasConnected = ok;
      },
    });
    const releaseSpace = () => useStore.setState({ spaceHeld: false });
    // Pinching over panels would otherwise zoom the whole page.
    const blockPageZoom = (e: Event) => {
      if (e.type !== 'wheel' || (e as WheelEvent).ctrlKey) e.preventDefault();
    };
    window.addEventListener('wheel', blockPageZoom, { passive: false });
    window.addEventListener('gesturestart', blockPageZoom);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', releaseSpace);
    window.addEventListener('paste', onPaste);
    window.addEventListener('beforeunload', flushSave);
    return () => {
      stopAutosave();
      stopEvents();
      clearInterval(capsTimer);
      window.removeEventListener('wheel', blockPageZoom);
      window.removeEventListener('gesturestart', blockPageZoom);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseSpace);
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('beforeunload', flushSave);
    };
  }, []);

  const editing = useStore((s) => s.editing);
  return (
    <>
      <Canvas />
      <TopBar />
      <LeftToolbar />
      {editing ? editing.kind === 'outpaint' ? <OutpaintPanel /> : <MaskPanel /> : <Composer />}
      <AgentPanel />
      <Lightbox />
      <Modals />
      <Toasts />
    </>
  );
}

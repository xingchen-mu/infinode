import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Project } from '../shared/types.ts';

test('autosave recovers from failures and protects unsaved edits', async (t) => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { innerWidth: 1200, innerHeight: 800 } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    documentElement: {}, body: { classList: { contains: () => false } },
  } });
  const { api } = await import('../src/lib/api.ts');
  const { useStore } = await import('../src/store.ts');
  const { openProject, savePending, setupAutosave } = await import('../src/projects/sync.ts');
  const board = (id: string): Project => ({
    id, name: id, items: [], viewport: { x: 1, y: 1, zoom: 1 }, createdAt: 1, updatedAt: 1,
  });
  t.mock.method(api, 'project', async (id: string) => board(id));
  t.mock.method(api, 'tasks', async () => []);
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

  await t.test('a failed save retries without another edit and persists the latest name', async (t) => {
    await openProject('board-one');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const stop = setupAutosave();
    t.after(stop);
    let calls = 0;
    let savedName = '';
    t.mock.method(api, 'saveProject', async (_id: string, patch: { name: string }) => {
      if (++calls === 1) throw new Error('temporary outage');
      savedName = patch.name;
      return { updatedAt: 2 };
    });
    useStore.setState({ projectName: 'Recovered edit' });
    assert.equal(useStore.getState().saveState, 'saving');
    t.mock.timers.tick(700);
    await settle();
    assert.equal(useStore.getState().saveState, 'error');
    t.mock.timers.tick(3000);
    await settle();
    assert.equal(calls, 2);
    assert.equal(savedName, 'Recovered edit');
    assert.equal(useStore.getState().saveState, 'saved');
  });

  await t.test('switching boards and reading for the assistant wait for a successful save', async (t) => {
    await openProject('board-one');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const stop = setupAutosave();
    t.after(stop);
    let offline = true;
    t.mock.method(api, 'saveProject', async () => {
      if (offline) throw new Error('offline');
      return { updatedAt: 2 };
    });
    useStore.setState({ projectName: 'Keep this edit' });
    await assert.rejects(savePending());
    await openProject('board-two');
    assert.equal(useStore.getState().projectId, 'board-one');
    assert.equal(useStore.getState().projectName, 'Keep this edit');
    offline = false;
    await openProject('board-two');
    assert.equal(useStore.getState().projectId, 'board-two');
  });

  await t.test('an edit made during a save is not marked saved by the earlier response', async (t) => {
    await openProject('board-one');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const stop = setupAutosave();
    t.after(stop);
    let resolveFirst!: (value: { updatedAt: number }) => void;
    const names: string[] = [];
    t.mock.method(api, 'saveProject', async (_id: string, patch: { name: string }) => {
      names.push(patch.name);
      if (names.length === 1) return new Promise<{ updatedAt: number }>((resolve) => { resolveFirst = resolve; });
      return { updatedAt: 3 };
    });
    useStore.setState({ projectName: 'First edit' });
    t.mock.timers.tick(700);
    await settle();
    useStore.setState({ projectName: 'Latest edit' });
    resolveFirst({ updatedAt: 2 });
    await settle();
    assert.equal(useStore.getState().saveState, 'saving');
    await savePending();
    assert.deepEqual(names, ['First edit', 'Latest edit']);
    assert.equal(useStore.getState().saveState, 'saved');
  });

  await t.test('fitting a generated image keeps it below the top bar and above the composer', async () => {
    const { ensureVisible, fitAll } = await import('../src/canvas/view.ts');
    const item = { id: 'image-one', kind: 'image' as const, x: -256, y: -256, w: 512, h: 512, createdAt: 1 };
    useStore.setState({ screen: { w: 1200, h: 700 }, items: [item], viewport: { x: 600, y: 270, zoom: 1 } });
    const checkVisible = () => {
      const v = useStore.getState().viewport;
      assert.ok(item.y * v.zoom + v.y >= 60);
      assert.ok((item.y + item.h) * v.zoom + v.y <= 480);
    };
    ensureVisible(item);
    checkVisible();
    fitAll();
    checkVisible();
  });
});

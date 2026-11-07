// Queue positions and the websocket watchdog in the task manager, against a fake ComfyUI.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Task, TaskRequest } from '../shared/types.ts';
import type { ComfyClient, QueueState } from '../server/comfy/client.ts';
import type { AssetStore } from '../server/assets/store.ts';

const dataDir = await mkdtemp(join(tmpdir(), 'infinode-queue-'));
process.env.DATA_DIR = dataDir;
const { TaskManager } = await import('../server/tasks/manager.ts');
const managers: InstanceType<typeof TaskManager>[] = [];
after(async () => {
  // Let queue refreshes settle, then write the pending saves before the folder goes.
  await new Promise((r) => setTimeout(r, 300));
  // One at a time: they share the data folder's tasks.json.
  for (const m of managers) await m.flush();
  await rm(dataDir, { recursive: true, force: true });
});

const request: TaskRequest = { op: 'image.generate', model: 'zimage', prompt: 'x', aspect: '1:1', quality: '1k' };

function setup() {
  const queue: QueueState = { queue_running: [], queue_pending: [] };
  let number = 0;
  const comfy = {
    online: true,
    reconnects: 0,
    async queuePrompt(_graph: unknown, id: string) {
      queue.queue_pending.push([number++, id]);
      return { prompt_id: id, number };
    },
    queue: async () => structuredClone(queue),
    history: async () => undefined,
    reconnect() {
      this.reconnects++;
    },
  };
  const manager = new TaskManager(comfy as unknown as ComfyClient, { get: () => undefined } as unknown as AssetStore, () => undefined, () => undefined);
  managers.push(manager);
  const poll = () => (manager as unknown as { poll(force?: boolean): Promise<void> }).poll(true);
  /** ComfyUI takes the next prompt off the queue. */
  const startNext = () => {
    queue.queue_running = queue.queue_pending.splice(0, 1);
  };
  return { manager, comfy, poll, startNext };
}

const stateOf = (t: Task) => [t.status, t.queuePosition ?? null, t.stage];

test('queue positions follow ComfyUI even when its broadcasts never arrive', async () => {
  const { manager, poll, startNext } = setup();
  const [a, b, c] = [await manager.create(request), await manager.create(request), await manager.create(request)];
  startNext();
  await poll();
  assert.deepEqual([stateOf(a), stateOf(b), stateOf(c)], [
    ['running', null, '运行中'],
    ['queued', 1, '排队中 · 前面 1 个'],
    ['queued', 2, '排队中 · 前面 2 个'],
  ]);
  // The first finishes and the next starts, with no websocket message about either.
  startNext();
  await poll();
  assert.deepEqual([stateOf(b), stateOf(c)], [
    ['running', null, '运行中'],
    ['queued', 1, '排队中 · 前面 1 个'],
  ]);
});

test('a websocket that stopped hearing ComfyUI is reopened; a healthy one is left alone', async () => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    // Silent: neither the submit nor the queue moving produced a message.
    const silent = setup();
    await silent.manager.create(request);
    await silent.manager.create(request);
    silent.startNext();
    await silent.poll();
    offset += 7000;
    await silent.poll();
    assert.equal(silent.comfy.reconnects, 1);

    // Healthy: every change is followed by ComfyUI's status broadcast.
    const healthy = setup();
    await healthy.manager.create(request);
    await healthy.manager.create(request);
    healthy.manager.onComfyEvent({ type: 'status', data: {} });
    healthy.startNext();
    healthy.manager.onComfyEvent({ type: 'status', data: {} });
    await healthy.poll();
    offset += 7000;
    healthy.startNext();
    healthy.manager.onComfyEvent({ type: 'status', data: {} });
    await healthy.poll();
    offset += 7000;
    await healthy.poll();
    assert.equal(healthy.comfy.reconnects, 0);
  } finally {
    Date.now = realNow;
  }
});

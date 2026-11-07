// The canvas assistant end to end with pi's faux model: no API key, no ComfyUI.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'infinode-agent-test-'));
const { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } = await import('@earendil-works/pi-ai');
const { AssetStore } = await import('../server/assets/store.ts');
const { ProjectStore } = await import('../server/projects/store.ts');
const { AgentHub, compactThreshold } = await import('../server/agent/runtime.ts');
type Task = import('../shared/types.ts').Task;
type TaskRequest = import('../shared/types.ts').TaskRequest;
type AssistantMessage = ReturnType<typeof fauxAssistantMessage>;
/** A scripted reply, or a function of what the model was sent. */
type Step = Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0][number];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A task queue that accepts everything; tests finish tasks by hand. Records can be shared across "restarts". */
function fakeTasks(records = new Map<string, Task>()) {
  let n = 0;
  const events = new EventEmitter();
  const created: TaskRequest[] = [];
  return Object.assign(events, {
    records,
    created,
    list(ids?: string[]) {
      return ids ? ids.map((id) => records.get(id)).filter((t): t is Task => Boolean(t)) : [...records.values()];
    },
    async create(request: TaskRequest) {
      created.push(request);
      const video = request.op === 'video.generate';
      const task: Task = { id: `task${Date.now()}${++n}`.slice(-14), request, status: 'queued', progress: 0, results: [], seed: 1, createdAt: Date.now(), expected: { kind: video ? 'video' : 'image', width: 1344, height: 768 } };
      records.set(task.id, task);
      return task;
    },
    async cancel(id: string) {
      return records.get(id);
    },
    finish(id: string) {
      const t = records.get(id)!;
      Object.assign(t, { status: 'done', progress: 1, startedAt: Date.now() - 1000, finishedAt: Date.now(), results: [{ id: `a-${id}`, url: `/files/a-${id}.mp4`, kind: t.expected.kind, mime: 'video/mp4', width: 1344, height: 768 }] });
      events.emit('task', t);
    },
  });
}

const projects = new ProjectStore();
const assets = new AssetStore();
await Promise.all([projects.init(), assets.init()]);

async function hubWith(tasks: ReturnType<typeof fakeTasks>, responses: Step[], opts: { compactAt?: number; commercial?: boolean; approvalMode?: 'always' } = {}) {
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-1', input: ['text', 'image'], contextWindow: 200_000 }] });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const deps = {
    projects,
    tasks,
    assets,
    workflows: () => [],
    capabilities: async () => ({ comfyOnline: true, comfyUrl: '', features: {}, models: {} }),
    changed: () => {},
    commercialOnly: () => Boolean(opts.commercial),
  } as unknown as ConstructorParameters<typeof AgentHub>[0];
  const settings = opts.approvalMode
    ? ({ agentConfig: () => ({ model: 'faux/faux-1', vision: true, thinking: 'low', approvalMode: opts.approvalMode }) } as ConstructorParameters<typeof AgentHub>[3])
    : undefined;
  const hub = new AgentHub(deps, () => {}, { models, model: 'faux/faux-1', compactAt: opts.compactAt }, settings);
  await hub.init();
  assert.equal(hub.status.ready, true, hub.status.reason ?? '');
  return { hub, faux };
}

async function settled(hub: InstanceType<typeof AgentHub>, projectId: string) {
  for (let i = 0; i < 300; i++) {
    const v = await hub.view(projectId);
    if (!v.running) return v;
    await sleep(20);
  }
  throw new Error('the run did not settle');
}

const say = (text: string, input = 100): AssistantMessage => ({
  ...fauxAssistantMessage(text),
  usage: { input, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: input + 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } },
});

test('a tool call edits the board, and the conversation survives a restart', async () => {
  const board = await projects.create('notes');
  const tasks = fakeTasks();
  const { hub } = await hubWith(tasks, [fauxAssistantMessage(fauxToolCall('write_note', { title: '剧本', content: '- 第一场：深夜' })), say('写好了')]);
  await hub.send(board.id, { text: '写个剧本' });
  const view = await settled(hub, board.id);
  const note = (await projects.get(board.id))!.items.find((i) => i.kind === 'text');
  assert.equal(note?.name, '剧本');
  assert.deepEqual(
    view.entries.map((e) => e.kind),
    ['user', 'tool', 'assistant'],
  );
  assert.ok(view.usage.tokens > 0);

  const { hub: again } = await hubWith(tasks, []);
  const reloaded = await again.view(board.id);
  assert.deepEqual(
    reloaded.entries.map((e) => (e.kind === 'assistant' ? e.text : e.kind)),
    ['user', 'tool', '写好了'],
  );
  assert.equal(reloaded.usage.tokens, view.usage.tokens);
});

test('the assistant can require approval before every canvas write', async () => {
  const board = await projects.create('approval mode');
  const tasks = fakeTasks();
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-approval', input: ['text'], contextWindow: 200_000 }] });
  faux.setResponses([fauxAssistantMessage(fauxToolCall('write_note', { title: '待确认', content: '不会未经确认写入' })), say('已等待确认')]);
  const models = createModels();
  models.setProvider(faux.provider);
  const deps = {
    projects,
    tasks,
    assets,
    workflows: () => [],
    capabilities: async () => ({ comfyOnline: true, comfyUrl: '', features: {}, models: {} }),
    changed: () => {},
    commercialOnly: () => false,
  } as unknown as ConstructorParameters<typeof AgentHub>[0];
  const settings = { agentConfig: () => ({ model: 'faux/faux-approval', vision: false, thinking: 'low', approvalMode: 'always' as const }) } as ConstructorParameters<typeof AgentHub>[3];
  const hub = new AgentHub(deps, () => {}, { models, model: 'faux/faux-approval' }, settings);
  await hub.init();
  await hub.send(board.id, { text: '写一个备注' });
  const waiting = await settled(hub, board.id);
  const card = waiting.entries.find((e) => e.kind === 'tool' && e.status === 'waiting');
  assert.ok(card && card.kind === 'tool' && card.approval);
  assert.equal((await projects.get(board.id))!.items.length, 0);
  await hub.approve(board.id, card.id, true);
  assert.equal((await projects.get(board.id))!.items[0]?.name, '待确认');
});

test('approved videos are queued, and after a restart the agent still carries on when they finish', async () => {
  const board = await projects.create('videos');
  const frame = { id: 'frame00001', kind: 'image' as const, x: 0, y: 0, w: 512, h: 288, createdAt: 1, asset: { id: 'af', url: '/files/af.png', kind: 'image' as const, mime: 'image/png', width: 1376, height: 768 } };
  await projects.patchItems(board.id, { upsert: [frame] });
  const records = new Map<string, Task>();
  const before = fakeTasks(records);
  const { hub } = await hubWith(before, [fauxAssistantMessage(fauxToolCall('batch_generate_videos', { jobs: [{ prompt: '她抬头笑了', first_frame_id: frame.id, name: 'S01' }] })), say('等你确认')]);
  await hub.send(board.id, { text: '做成视频' });
  const waiting = (await settled(hub, board.id)).entries.find((e) => e.kind === 'tool' && e.status === 'waiting');
  assert.ok(waiting && waiting.kind === 'tool' && waiting.approval, 'an approval card');
  await hub.approve(board.id, waiting.id, true);
  assert.equal(before.created.length, 1);
  const video = (await projects.get(board.id))!.items.find((i) => i.kind === 'video')!;
  assert.equal(video.y, frame.y, 'beside its frame');
  assert.ok(existsSync(join(process.env.DATA_DIR!, 'agent', 'watches.json')));

  // A new server process: same task records, a new event stream, the notice read back from disk.
  const after = fakeTasks(records);
  const { hub: restarted } = await hubWith(after, [say('视频好了，接着剪辑')]);
  after.finish(video.taskId!);
  await sleep(700);
  const view = await settled(restarted, board.id);
  const texts = view.entries.map((e) => (e.kind === 'tool' ? e.label : e.text));
  assert.ok(texts.some((t) => t.includes('都结束了')), texts.join(' | '));
  assert.equal(texts.at(-1), '视频好了，接着剪辑');
});

test('a video card shows its first frames, submits a keyframe redone after it, and gives way to a newer card', async () => {
  const board = await projects.create('redo');
  const asset = (id: string) => ({ id, url: `/files/${id}.png`, kind: 'image' as const, mime: 'image/png', width: 1376, height: 768 });
  const old = { id: 'kf0000old1', kind: 'image' as const, x: 0, y: 0, w: 512, h: 288, createdAt: 1, name: 'S04', group: '关键帧', asset: asset('aold') };
  await projects.patchItems(board.id, { upsert: [old] });
  const tasks = fakeTasks();
  // A new call (and call id) each time, as a model would make.
  const videos = () => fauxAssistantMessage(fauxToolCall('batch_generate_videos', { jobs: [{ prompt: '他站起来', first_frame_id: old.id, name: 'S04' }] }));
  let context = '';
  const { hub } = await hubWith(tasks, [
    (c) => {
      context = JSON.stringify(c.messages);
      return videos();
    },
    say('等你确认'),
    videos(),
    say('又提交了一次'),
    videos(),
    say('再提交一次'),
  ]);
  await hub.send(board.id, { text: '做成视频' });
  const card = (await settled(hub, board.id)).entries.find((e) => e.kind === 'tool' && e.status === 'waiting');
  assert.ok(card?.kind === 'tool' && card.approval?.frames?.[0] === old.id && card.approval.since, JSON.stringify(card));
  assert.match(context, /这台服务器的速度/, 'the measured speeds reach the model');

  // S04 is redone after the card was made, under the same name and group: confirming submits the new one.
  await projects.patchItems(board.id, { upsert: [{ ...old, id: 'kf0000new1', createdAt: Date.now() + 1, asset: asset('anew') }] });
  await hub.approve(board.id, card.id, true);
  const submitted = tasks.created[0];
  assert.deepEqual(submitted.op === 'video.generate' && submitted.images, ['anew']);
  const done = (await hub.view(board.id)).entries.find((e) => e.id === card.id);
  assert.ok(done?.kind === 'tool' && /重做后的首帧/.test(done.summary), JSON.stringify(done));

  // Two more cards: the newer one replaces the older, which can no longer be confirmed.
  await hub.send(board.id, { text: '再做一遍' });
  await settled(hub, board.id);
  await hub.send(board.id, { text: '还是再做一遍' });
  const cards = (await settled(hub, board.id)).entries.filter((e) => e.kind === 'tool' && e.tool === 'batch_generate_videos').slice(1);
  assert.deepEqual(
    cards.map((e) => e.kind === 'tool' && [e.status, e.summary]),
    [['done', '已被新的确认卡取代'], ['waiting', '等待确认']],
  );
  await assert.rejects(hub.approve(board.id, cards[0].id, true));
  assert.equal(tasks.created.length, 1);
});

test('deleting finished images waits for its own card, also when every write needs approval, and then the model reads what was done', async () => {
  const board = await projects.create('delete');
  const shot = { id: 'img0000del', kind: 'image' as const, x: 0, y: 0, w: 512, h: 288, createdAt: 1, asset: { id: 'adel', url: '/files/adel.png', kind: 'image' as const, mime: 'image/png', width: 1376, height: 768 } };
  await projects.patchItems(board.id, { upsert: [shot] });
  let context = '';
  const { hub } = await hubWith(
    fakeTasks(),
    [
      fauxAssistantMessage(fauxToolCall('delete_items', { ids: [shot.id] })),
      say('等你确认'),
      (c) => {
        context = JSON.stringify(c.messages);
        return say('删好了');
      },
    ],
    { approvalMode: 'always' },
  );
  await hub.send(board.id, { text: '把这张删了' });
  const card = (await settled(hub, board.id)).entries.find((e) => e.kind === 'tool' && e.status === 'waiting');
  assert.ok(card?.kind === 'tool' && card.approval?.confirm === '删除' && card.approval.frames?.[0] === shot.id, JSON.stringify(card));
  assert.equal((await projects.get(board.id))!.items.length, 1);

  await hub.approve(board.id, card.id, true);
  assert.equal((await projects.get(board.id))!.items.length, 0);
  await hub.send(board.id, { text: '删好了吗' });
  await settled(hub, board.id);
  assert.match(context, /用户已确认。已从画布删掉 1 个节点/);
});

test('a board keeps the latest ten snapshots the assistant took on its own; the ones the user saved stay', async () => {
  const board = await projects.create('snapshots');
  await projects.createSnapshot(board.id, '用户存的');
  for (let i = 0; i < 12; i++) {
    await sleep(2);
    await projects.createSnapshot(board.id, `自动 ${i}`, { auto: true });
  }
  const names = (await projects.listSnapshots(board.id)).map((s) => s.name);
  assert.equal(names.length, 11);
  assert.ok(names.includes('用户存的'));
  assert.deepEqual(names.slice(0, 10), Array.from({ length: 10 }, (_, i) => `自动 ${11 - i}`));
});

test('commercial-only mode makes image generation default to Z-Image', async () => {
  const board = await projects.create('commercial');
  const tasks = fakeTasks();
  const { hub } = await hubWith(tasks, [fauxAssistantMessage(fauxToolCall('generate_image', { prompt: '一只猫' })), say('好了')], { commercial: true });
  await hub.send(board.id, { text: '画只猫' });
  await settled(hub, board.id);
  assert.equal(tasks.created[0]?.op === 'image.generate' && tasks.created[0].model, 'zimage');
});

test('a long conversation is condensed into a summary, and the panel keeps the earlier rows', async () => {
  const board = await projects.create('long');
  const tasks = fakeTasks();
  const replies = Array.from({ length: 6 }, (_, i) => say(`回答 ${i + 1}`, 5000));
  const { hub } = await hubWith(tasks, [...replies, say('- 用户在做一部短剧\n- 剧本节点 abc', 300), say('回答 7')], { compactAt: 1000 });
  for (let i = 1; i <= 7; i++) {
    await hub.send(board.id, { text: `第 ${i} 句` });
    await settled(hub, board.id);
  }
  const view = await hub.view(board.id);
  const texts = view.entries.map((e) => (e.kind === 'tool' ? e.label : e.text));
  assert.ok(texts.includes('回答 1'), 'old rows stay in the panel');
  assert.ok(texts.some((t) => t.includes('摘要')), texts.join(' | '));
  assert.equal(texts.at(-1), '回答 7');
  const saved = JSON.parse(readFileSync(join(process.env.DATA_DIR!, 'agent', `${board.id}.json`), 'utf8'));
  assert.match(saved.messages[0].content, /^<canvas_summary>/);
  assert.ok(saved.messages.length < 14, `transcript shrank to ${saved.messages.length}`);
});

test('condensing keeps what the user typed word for word, also through a second summary', async () => {
  const board = await projects.create('words');
  let second = '';
  const long = (i: number) => say(`回答 ${i}`, 5000);
  const { hub } = await hubWith(
    fakeTasks(),
    [
      ...[1, 2, 3, 4, 5, 6].map(long),
      say('- 第一次整理', 300),
      long(7),
      long(8),
      (context) => {
        second = JSON.stringify(context.messages);
        return say('- 第二次整理', 300);
      },
      say('回答 9'),
    ],
    { compactAt: 1000 },
  );
  for (let i = 1; i <= 9; i++) {
    await hub.send(board.id, { text: `第 ${i} 句：主角叫林晚` });
    await settled(hub, board.id);
  }
  const saved = JSON.parse(readFileSync(join(process.env.DATA_DIR!, 'agent', `${board.id}.json`), 'utf8'));
  const summary: string = saved.messages[0].content;
  assert.match(summary, /^<canvas_summary>\n- 第二次整理/);
  for (const i of [1, 2, 3, 4]) assert.ok(summary.includes(`<said>第 ${i} 句：主角叫林晚</said>`), summary);
  assert.ok(!summary.includes('canvas_context'), 'without the board context of the time');
  assert.ok(second.includes('【之前的整理】- 第一次整理'), 'the first summary is condensed again');
  assert.ok(!second.includes('<said>'), 'without the words carried in it');
  const texts = (await hub.view(board.id)).entries.map((e) => (e.kind === 'tool' ? e.label : e.text));
  assert.equal(texts.at(-1), '回答 9');
});

test('an OpenAI-compatible endpoint takes its context length and reasoning from the settings', () => {
  assert.equal(compactThreshold(32_000), 19_200, 'condensed well inside a small window');
  assert.equal(compactThreshold(1_000_000), 100_000);
  assert.equal(compactThreshold(undefined), 100_000);
  const deps = { projects, tasks: fakeTasks(), assets, workflows: () => [], capabilities: async () => ({}), changed: () => {} } as unknown as ConstructorParameters<typeof AgentHub>[0];
  const settings = (reasoning: boolean, contextWindow?: number) =>
    ({
      agentConfig: () => ({ model: 'local-chat', baseUrl: 'http://127.0.0.1:9/v1', vision: false, thinking: 'medium', approvalMode: 'risky', contextWindow, reasoning }),
    }) as unknown as ConstructorParameters<typeof AgentHub>[3];
  type Inside = { model: { contextWindow: number; maxTokens: number; reasoning: boolean }; thinking: string; compactAt: number };
  const small = new AgentHub(deps, () => {}, {}, settings(true, 32_000)) as unknown as Inside;
  assert.deepEqual([small.model.contextWindow, small.model.reasoning, small.thinking, small.compactAt], [32_000, true, 'medium', 19_200]);
  const plain = new AgentHub(deps, () => {}, {}, settings(false)) as unknown as Inside;
  assert.deepEqual([plain.model.contextWindow, plain.model.reasoning, plain.thinking, plain.compactAt], [128_000, false, 'off', 76_800]);
});

test('after switching to English, panel rows are in English and the model is told to answer in English', async () => {
  const { setServerLang } = await import('../server/i18n.ts');
  const board = await projects.create('english');
  let seen = '';
  const { hub } = await hubWith(fakeTasks(), [
    say('好的'),
    (context) => {
      seen = JSON.stringify(context);
      return fauxAssistantMessage(fauxToolCall('write_note', { title: 'Script', content: '- Scene 1' }));
    },
    say('Done'),
  ]);
  await hub.send(board.id, { text: '你好' });
  await settled(hub, board.id);
  setServerLang('en');
  try {
    await hub.send(board.id, { text: 'Write a script' });
    const view = await settled(hub, board.id);
    assert.ok(seen.includes("The user's interface is in English"), 'the language rule reaches the model');
    const row = view.entries.find((e) => e.kind === 'tool');
    assert.ok(row?.kind === 'tool' && row.label === 'Write note' && row.summary === '"Script"', JSON.stringify(row));
  } finally {
    setServerLang('zh');
  }
});

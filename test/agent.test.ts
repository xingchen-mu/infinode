// The canvas assistant end to end with pi's faux model: no API key, no ComfyUI.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'infinode-agent-test-'));
const { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } = await import('@earendil-works/pi-ai');
const { AssetStore } = await import('../server/assets/store.ts');
const { ProjectStore } = await import('../server/projects/store.ts');
const { AgentHub, clearOldToolUse, compactThreshold } = await import('../server/agent/runtime.ts');
type Task = import('../shared/types.ts').Task;
type TaskRequest = import('../shared/types.ts').TaskRequest;
type AgentEventData = import('../shared/types.ts').AgentEventData;
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

async function hubWith(tasks: ReturnType<typeof fakeTasks>, responses: Step[], opts: { compactAt?: number; clearAt?: number; commercial?: boolean; approvalMode?: 'always' | 'prompts' } = {}) {
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
  // What the panel was sent, rows that are not saved with the conversation included.
  const emitted: AgentEventData[] = [];
  const hub = new AgentHub(deps, (e) => emitted.push(e), { models, model: 'faux/faux-1', compactAt: opts.compactAt, clearAt: opts.clearAt }, settings);
  await hub.init();
  assert.equal(hub.status.ready, true, hub.status.reason ?? '');
  return { hub, faux, emitted };
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

test('the token count leaves out cache reads, also for a conversation saved before the change', async () => {
  const board = await projects.create('tokens');
  const { hub } = await hubWith(fakeTasks(), [say('好的'), say('还在')]);
  for (const text of ['你好', '在吗']) {
    await hub.send(board.id, { text });
    await settled(hub, board.id);
  }
  // The faux model reports its own usage, cache reads included: the count takes all but those.
  const file = join(process.env.DATA_DIR!, 'agent', `${board.id}.json`);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  const usages = saved.messages.filter((m: AssistantMessage) => m.role === 'assistant').map((m: AssistantMessage) => m.usage);
  const paid = usages.reduce((n: number, u: AssistantMessage['usage']) => n + u.input + u.output + u.cacheWrite, 0);
  assert.ok(usages.some((u: AssistantMessage['usage']) => u.cacheRead > 0), 'the second request reads the first from the cache');
  assert.equal(saved.version, 3);
  assert.equal(saved.usage.tokens, paid);
  assert.equal((await hub.view(board.id)).usage.tokens, paid);

  // As saved before: 30 000 tokens with cache reads, 9150 of them in the one reply still there, the rest condensed.
  const reply = saved.messages.find((m: AssistantMessage) => m.role === 'assistant');
  reply.usage = { ...reply.usage, input: 100, output: 50, cacheRead: 9000, cacheWrite: 0, totalTokens: 9150 };
  const messages = saved.messages.slice(0, saved.messages.indexOf(reply) + 1);
  writeFileSync(file, JSON.stringify({ ...saved, version: 2, messages, usage: { tokens: 30_000, cost: 0.01 } }));
  const { hub: restarted } = await hubWith(fakeTasks(), []);
  // 150 counted again, and the condensed 20 850 at the same share of paid tokens (150 of 9150).
  assert.deepEqual((await restarted.view(board.id)).usage, { tokens: 492, cost: 0.01 });
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

type AgentMessage = Parameters<typeof clearOldToolUse>[0][number];

test('clearing old tool use takes results and long arguments of all but the latest calls, never errors, and only once', () => {
  const long = '镜'.repeat(2000);
  const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: 'toolCall', id, name, arguments: args });
  const result = (id: string, name: string, text: string, isError = false) => ({ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], isError, timestamp: 2 });
  const before = [
    { role: 'user', content: '写分镜表', timestamp: 1 },
    { role: 'assistant', content: [call('c1', 'write_note', { title: '分镜表', content: long }), call('c2', 'read_board', {})], timestamp: 2 },
    result('c1', 'write_note', '已新建文本节点'),
    result('c2', 'read_board', long),
    { role: 'assistant', content: [call('c3', 'read_board', { ids: ['a'] })], timestamp: 3 },
    result('c3', 'read_board', long, true),
    { role: 'assistant', content: [call('c4', 'batch_generate_images', { jobs: [{ prompt: long }] })], timestamp: 4 },
    result('c4', 'batch_generate_images', long),
  ] as unknown as AgentMessage[];
  const copy = JSON.stringify(before);
  const { messages, freed, cleared } = clearOldToolUse(before, 1);
  const json = JSON.stringify(messages);
  assert.equal(cleared, 2, 'the note text in c1, the board read in c2');
  assert.ok(freed > 3900 && freed < 4000, String(freed));
  assert.match(json, /\[已清掉 2000 字，原文在画布上\]/);
  assert.match(json, /\[已清掉较早的 read_board 结果，2000 字，需要时重新调用\]/);
  assert.match(json, /"title":"分镜表"/, 'short arguments stay');
  assert.equal((messages[5] as { content: { text: string }[] }).content[0].text, long, 'an error stays: the panel shows it');
  assert.equal(JSON.stringify(messages.slice(6)), JSON.stringify(before.slice(6)), 'the latest call stays whole');
  assert.equal(JSON.stringify(before), copy, 'the messages given are not changed');
  assert.equal(clearOldToolUse(messages, 1).freed, 0, 'nothing more the second time');
});

test('past the clearing mark, old tool results are cleared before the next request, without a summary', async () => {
  const board = await projects.create('clearing');
  const reads = Array.from({ length: 8 }, (_, i) => fauxToolCall('read_guide', { name: 'short_drama' }, { id: `read${i}` }));
  let second = '';
  const { hub, emitted } = await hubWith(
    fakeTasks(),
    [
      fauxAssistantMessage(reads),
      say('读完了'),
      (context) => {
        second = JSON.stringify(context.messages);
        return say('接着写');
      },
    ],
    { clearAt: 100, compactAt: 10_000_000 },
  );
  await hub.send(board.id, { text: '读一下手册' });
  await settled(hub, board.id);
  await hub.send(board.id, { text: '继续' });
  await settled(hub, board.id);
  const events = emitted.flatMap((e) => (e.entry?.kind === 'event' ? [e.entry.text] : []));
  assert.equal(events.length, 1, events.join(' | '));
  assert.match(events[0], /^已清掉 2 处较早的工具结果，上下文少了 \d+ 字$/);
  assert.equal((second.match(/\[已清掉较早的 read_guide 结果/g) ?? []).length, 2, 'the two oldest of eight, the latest six stay');
  assert.ok(!second.includes('<canvas_summary>'));
});

test('condensing on request keeps what the user asked for, shows the summary in the panel, and says when there is nothing to condense', async () => {
  const board = await projects.create('condense');
  let asked = '';
  const { hub } = await hubWith(fakeTasks(), [
    say('好的，主角叫林晚'),
    say('分镜表写好了'),
    say('关键帧在出'),
    (context) => {
      asked = JSON.stringify(context.messages);
      return say('## 目标和要求\n- 做一部短剧\n## 定下来的事\n- 主角叫林晚');
    },
  ]);
  for (const text of ['主角叫林晚', '写分镜表', '出关键帧']) {
    await hub.send(board.id, { text });
    await settled(hub, board.id);
  }
  await hub.condense(board.id, '人物设定');
  assert.match(asked, /用户希望这次整理特别保留：人物设定/);
  const view = await hub.view(board.id);
  assert.equal(view.running, false);
  const summary = view.entries.find((e) => e.kind === 'event' && e.detail);
  assert.ok(summary?.kind === 'event' && /^## 目标和要求/.test(summary.detail!), JSON.stringify(summary));
  const texts = view.entries.map((e) => (e.kind === 'event' ? 'event' : e.kind === 'tool' ? e.label : e.text));
  assert.deepEqual(texts.slice(-3), ['event', '出关键帧', '关键帧在出'], 'the last message and its reply stay word for word');
  await assert.rejects(hub.condense(board.id), /对话还很短/);
});

test('with prompts shown first, an image waits on a card with its prompt, and is generated from the edited one', async () => {
  const board = await projects.create('prompts');
  const tasks = fakeTasks();
  let told = '';
  const { hub } = await hubWith(
    tasks,
    [
      fauxAssistantMessage(fauxToolCall('generate_image', { prompt: '一只猫坐在窗台上', name: '猫' })),
      say('提示词在等你确认'),
      (context) => {
        told = JSON.stringify(context.messages);
        return say('好的');
      },
    ],
    { approvalMode: 'prompts' },
  );
  await hub.send(board.id, { text: '画只猫' });
  const card = (await settled(hub, board.id)).entries.find((e) => e.kind === 'tool' && e.status === 'waiting');
  assert.ok(card?.kind === 'tool' && card.approval?.title === '生成前确认提示词', JSON.stringify(card));
  assert.deepEqual(card.approval?.prompts, [{ label: '猫', text: '一只猫坐在窗台上', refs: [] }]);
  assert.equal(tasks.created.length, 0, 'nothing generated before the user agrees');

  await hub.approve(board.id, card.id, true, ['一只橘猫坐在窗台上，傍晚的光']);
  assert.equal(tasks.created[0]?.op === 'image.generate' && tasks.created[0].prompt, '一只橘猫坐在窗台上，傍晚的光');
  await hub.send(board.id, { text: '好了吗' });
  await settled(hub, board.id);
  assert.match(told, /用户改了 1 条提示词，按改过的生成：.*猫：一只橘猫坐在窗台上，傍晚的光/);
});

test('with prompts shown first, a video batch card lists every prompt, and edits reach the jobs; reading and writing notes need no card', async () => {
  const board = await projects.create('video prompts');
  const frame = (id: string) => ({ id, kind: 'image' as const, x: 0, y: 0, w: 512, h: 288, createdAt: 1, asset: { id: `a${id}`, url: `/files/a${id}.png`, kind: 'image' as const, mime: 'image/png', width: 1376, height: 768 } });
  await projects.patchItems(board.id, { upsert: [frame('frame0000a1'), frame('frame0000a2')] });
  const tasks = fakeTasks();
  const { hub } = await hubWith(
    tasks,
    [
      fauxAssistantMessage([
        fauxToolCall('write_note', { title: '分镜表', content: 'S01、S02' }),
        fauxToolCall('batch_generate_videos', {
          jobs: [
            { prompt: '她抬头', first_frame_id: 'frame0000a1', name: 'S01' },
            { prompt: '她转身走开', first_frame_id: 'frame0000a2', name: 'S02' },
          ],
        }),
      ]),
      say('等你确认'),
    ],
    { approvalMode: 'prompts' },
  );
  await hub.send(board.id, { text: '做成视频' });
  const view = await settled(hub, board.id);
  assert.ok((await projects.get(board.id))!.items.some((i) => i.name === '分镜表'), 'a note is written without asking');
  const card = view.entries.find((e) => e.kind === 'tool' && e.status === 'waiting');
  assert.ok(card?.kind === 'tool' && card.tool === 'batch_generate_videos', JSON.stringify(card));
  assert.deepEqual(
    card.approval?.prompts?.map((p) => [p.label, p.text, p.refs]),
    [
      ['S01', '她抬头', ['frame0000a1']],
      ['S02', '她转身走开', ['frame0000a2']],
    ],
  );
  await hub.approve(board.id, card.id, true, ['她抬头', '她回头看了一眼，转身走开']);
  assert.deepEqual(
    tasks.created.map((r) => r.op === 'video.generate' && r.prompt),
    ['她抬头', '她回头看了一眼，转身走开'],
  );
});

test('what the assistant remembers is in the instructions of every new conversation, and stays put within one', async () => {
  const board = await projects.create('remember');
  let same = '';
  const { hub } = await hubWith(fakeTasks(), [
    fauxAssistantMessage(fauxToolCall('remember', { changes: [{ action: 'add', scope: 'board', type: 'setting', text: '主角叫林晚，短发' }] })),
    say('记住了'),
    (context) => {
      same = JSON.stringify(context);
      return say('好');
    },
  ]);
  await hub.send(board.id, { text: '主角叫林晚，短发，记住' });
  const row = (await settled(hub, board.id)).entries.find((e) => e.kind === 'tool' && e.tool === 'remember');
  assert.ok(row?.kind === 'tool' && row.summary === '记住了画布记忆「主角叫林晚，短发」', JSON.stringify(row));
  assert.equal((await hub.memories(board.id)).board.entries[0]?.text, '主角叫林晚，短发');
  await hub.send(board.id, { text: '继续' });
  await settled(hub, board.id);
  assert.doesNotMatch(same, /\[m[\w-]+ · 设定\] 主角叫林晚/, 'the instructions stay as they were, for the cache');

  let fresh = '';
  const { hub: restarted } = await hubWith(fakeTasks(), [
    (context) => {
      fresh = JSON.stringify(context);
      return say('好');
    },
  ]);
  await restarted.send(board.id, { text: '你好' });
  await settled(restarted, board.id);
  assert.match(fresh, /\[m[\w-]+ · 设定\] 主角叫林晚，短发/);
});

test('an edit in the memory page reaches the assistant with the next message', async () => {
  const board = await projects.create('memory page');
  let next = '';
  const { hub } = await hubWith(fakeTasks(), [
    say('你好'),
    (context) => {
      next = JSON.stringify(context.messages.at(-1));
      return say('好的');
    },
  ]);
  await hub.send(board.id, { text: '你好' });
  await settled(hub, board.id);
  await hub.saveMemory(board.id, 'user', { auto: true, entries: [{ id: '', type: 'preference', text: '不要字幕', at: 0, by: 'user' }] });
  await hub.send(board.id, { text: '出一段视频' });
  await settled(hub, board.id);
  assert.match(next, /用户在记忆页改过记忆，以这一份为准.*不要字幕/);
  await hub.saveMemory(board.id, 'user', { auto: true, entries: [] });
});

test('condensing writes down what lasts, notes where the work stands, and the next request reads the new memory', async () => {
  const board = await projects.create('condense memory');
  const image = (id: string, name: string) => ({ id, kind: 'image' as const, x: 0, y: 0, w: 512, h: 288, name, group: '关键帧', createdAt: 1, asset: { id: `a${id}`, url: `/files/a${id}.png`, kind: 'image' as const, mime: 'image/png', width: 1376, height: 768 } });
  await projects.patchItems(board.id, {
    upsert: [{ id: 'note000001', kind: 'text', x: 0, y: 0, w: 400, h: 300, name: '剧本', text: '第一场：深夜便利店', createdAt: 1 }, image('key0000001', 'S01'), image('key0000002', 'S02')],
  });
  let asked = '';
  let after = '';
  const { hub } = await hubWith(fakeTasks(), [
    fauxAssistantMessage(fauxToolCall('read_guide', { name: 'short_drama', section: 'shots' })),
    say('读完了'),
    fauxAssistantMessage(fauxToolCall('update_todos', { todos: [{ content: '出关键帧', status: 'completed' }, { content: '出视频', status: 'in_progress' }] })),
    say('开始出视频'),
    say('在出了'),
    (context) => {
      asked = JSON.stringify(context.messages);
      return say('## 目标和要求\n- 做一部短剧\n## 下一步\n- 出视频\n<memory_updates>\n[{"action":"add","scope":"board","type":"decision","text":"画风用日系动画","why":"用户否掉了写实"}]\n</memory_updates>');
    },
    (context) => {
      after = JSON.stringify(context);
      return say('好');
    },
  ]);
  for (const text of ['看看分镜手册', '列个待办', '出视频吧，画风就用日系动画']) {
    await hub.send(board.id, { text });
    await settled(hub, board.id);
  }
  await hub.condense(board.id);
  assert.match(asked, /现有记忆/);
  assert.deepEqual((await hub.memories(board.id)).board.entries.map((e) => [e.type, e.text, e.why]), [['decision', '画风用日系动画', '用户否掉了写实']]);

  const summary = (await hub.view(board.id)).entries.find((e) => e.kind === 'event' && e.detail);
  const detail = summary?.kind === 'event' ? summary.detail! : '';
  assert.doesNotMatch(detail, /memory_updates/);
  assert.match(detail, /整理时的状态：/);
  assert.match(detail, /待办：✓ 出关键帧；▶ 出视频/);
  assert.match(detail, /`note000001`「剧本」9 字/);
  assert.match(detail, /关键帧 2 张（S01、S02）/);
  assert.match(detail, /short_drama · shots/);

  await hub.send(board.id, { text: '继续' });
  await settled(hub, board.id);
  assert.match(after, /\[m[\w-]+ · 决定\] 画风用日系动画（用户否掉了写实）/, 'the instructions after condensing carry the new memory');
});

test('deleting a board deletes its memory, and leaves the user\'s', async () => {
  const board = await projects.create('forget');
  const { hub } = await hubWith(fakeTasks(), []);
  await hub.saveMemory(board.id, 'board', { auto: true, entries: [{ id: '', type: 'setting', text: '主角叫林晚', at: 0, by: 'user' }] });
  await hub.saveMemory(board.id, 'user', { auto: true, entries: [{ id: '', type: 'preference', text: '默认 16:9', at: 0, by: 'user' }] });
  await hub.forget(board.id);
  const left = await hub.memories(board.id);
  assert.deepEqual([left.board.entries.length, left.user.entries.length], [0, 1]);
  await hub.saveMemory(board.id, 'user', { auto: true, entries: [] });
});

test('the to-do list shows in the panel without a row of its own, rides along with each message, and survives a restart', async () => {
  const board = await projects.create('todos');
  const steps = [
    { content: '写剧本', status: 'completed' },
    { content: '出关键帧', status: 'in_progress' },
    { content: '出视频', status: 'pending' },
  ];
  let next = '';
  const { hub, emitted } = await hubWith(fakeTasks(), [
    fauxAssistantMessage(fauxToolCall('update_todos', { todos: steps })),
    say('开始做'),
    (context) => {
      next = JSON.stringify(context.messages.at(-1));
      return say('接着做');
    },
  ]);
  await hub.send(board.id, { text: '做一部短剧' });
  const view = await settled(hub, board.id);
  assert.deepEqual(view.todos, steps);
  assert.ok(emitted.some((e) => e.todos?.length === 3), 'the panel hears of it as it happens');
  assert.ok(!view.entries.some((e) => e.kind === 'tool'), 'no tool row for it');
  await hub.send(board.id, { text: '继续' });
  await settled(hub, board.id);
  assert.match(next, /你的待办（1\/3 完成）：.*- \[x\] 写剧本.*- \[>\] 出关键帧.*- \[ \] 出视频/);

  const { hub: restarted } = await hubWith(fakeTasks(), []);
  assert.deepEqual((await restarted.view(board.id)).todos, steps);
  await restarted.clear(board.id);
  assert.deepEqual((await restarted.view(board.id)).todos, []);
});

test('a question card waits for a click; the answer goes to the assistant as the user message, and writing past it skips it', async () => {
  const board = await projects.create('question');
  const ask = (q: string) => fauxAssistantMessage(fauxToolCall('ask_user', { question: q, options: [{ label: '日系动画' }, { label: '写实', description: '像电影剧照' }] }));
  let answer = '';
  const { hub } = await hubWith(fakeTasks(), [
    ask('画风选哪种？'),
    say('等你选'),
    (context) => {
      answer = JSON.stringify(context.messages.at(-1));
      return ask('比例呢？');
    },
    say('再等你选'),
    say('好的，用 16:9'),
  ]);
  await hub.send(board.id, { text: '做一张海报' });
  const card = (await settled(hub, board.id)).entries.find((e) => e.kind === 'tool' && e.tool === 'ask_user');
  assert.ok(card?.kind === 'tool' && card.status === 'waiting' && card.question?.options[1].description === '像电影剧照', JSON.stringify(card));

  await hub.answer(board.id, card.id, '写实');
  const view = await settled(hub, board.id);
  assert.match(answer, /回答「画风选哪种？」：写实/);
  const first = view.entries.find((e) => e.id === card.id);
  assert.ok(first?.kind === 'tool' && first.status === 'done' && first.question?.state === 'answered' && first.summary === '已回答：写实', JSON.stringify(first));
  await assert.rejects(hub.answer(board.id, card.id, '日系动画'), /已经回答过了/);

  // The second question is left open, and the user writes something else.
  const second = view.entries.findLast((e) => e.kind === 'tool' && e.tool === 'ask_user')!;
  await hub.send(board.id, { text: '就用 16:9 吧' });
  const after = (await settled(hub, board.id)).entries.find((e) => e.id === second.id);
  assert.ok(after?.kind === 'tool' && after.question?.state === 'skipped' && after.summary === '没有回答', JSON.stringify(after));
});

test('plan mode lets the assistant read but not change the board, until the user accepts its plan', async () => {
  const board = await projects.create('plan');
  let told = '';
  let woken = '';
  const { hub, emitted } = await hubWith(fakeTasks(), [
    (context) => {
      told = JSON.stringify(context.messages.at(-1));
      return fauxAssistantMessage([fauxToolCall('read_board', {}), fauxToolCall('write_note', { title: '剧本', content: '先写了再说' })]);
    },
    fauxAssistantMessage(fauxToolCall('present_plan', { plan: '## 方案\n1. 写剧本\n2. 出三张关键帧' })),
    say('方案在等你确认'),
    (context) => {
      woken = JSON.stringify(context.messages.at(-1));
      return say('开始写剧本');
    },
  ]);
  await hub.setPlan(board.id, true);
  assert.ok(emitted.some((e) => e.plan === true));
  await hub.send(board.id, { text: '做一部短剧' });
  const view = await settled(hub, board.id);
  assert.match(told, /现在是计划模式/);
  const tools = view.entries.filter((e) => e.kind === 'tool');
  assert.deepEqual(
    tools.map((e) => e.kind === 'tool' && [e.tool, e.status]),
    [
      ['read_board', 'done'],
      ['write_note', 'error'],
      ['present_plan', 'waiting'],
    ],
  );
  assert.equal((await projects.get(board.id))!.items.length, 0, 'nothing written in plan mode');
  const card = tools[2];
  assert.ok(card.kind === 'tool' && card.approval?.body?.includes('出三张关键帧') && card.approval.confirm === '按这个做' && card.approval.reject === '再改改', JSON.stringify(card));

  await hub.approve(board.id, card.id, true);
  const done = await settled(hub, board.id);
  assert.equal(done.plan, false);
  assert.match(woken, /用户确认了方案，计划模式已关闭/);
});

test('going back to a message restores the board and the conversation, cancels work started since, and can itself be undone', async () => {
  const board = await projects.create('rewind');
  const tasks = fakeTasks();
  const cancelled: string[] = [];
  tasks.cancel = async (id: string) => {
    cancelled.push(id);
    return tasks.records.get(id);
  };
  const { hub } = await hubWith(tasks, [
    fauxAssistantMessage(fauxToolCall('write_note', { title: '剧本', content: '第一场' })),
    say('剧本写好了'),
    fauxAssistantMessage([fauxToolCall('write_note', { title: '分镜表', content: 'S01' }), fauxToolCall('generate_image', { prompt: '一只猫' })]),
    say('分镜表写好了，猫在画'),
  ]);
  await hub.send(board.id, { text: '写剧本' });
  await settled(hub, board.id);
  await hub.send(board.id, { text: '写分镜表，再画只猫' });
  const view = await settled(hub, board.id);
  assert.equal((await projects.get(board.id))!.items.length, 3);
  const users = view.entries.filter((e) => e.kind === 'user');
  assert.ok(users.every((e) => e.kind === 'user' && e.rewind));

  const { text } = await hub.rewind(board.id, users[1].id);
  assert.equal(text, '写分镜表，再画只猫');
  assert.deepEqual((await projects.get(board.id))!.items.map((i) => i.name), ['剧本']);
  assert.equal(tasks.created.length, 1);
  assert.deepEqual(cancelled, [...tasks.records.keys()], 'the cat, still queued');
  const back = await hub.view(board.id);
  assert.deepEqual(back.entries.map((e) => (e.kind === 'tool' ? e.tool : e.kind === 'user' || e.kind === 'assistant' ? e.text : e.kind)), ['写剧本', 'write_note', '剧本写好了']);
  assert.ok((await projects.listSnapshots(board.id)).some((s) => s.name === '回退对话之前'), 'the board before going back is kept');
  await assert.rejects(hub.rewind(board.id, users[1].id), /回不到这条消息了/);
});

test('the panel learns how full the context is, unknown again right after condensing', async () => {
  const board = await projects.create('context');
  const { hub } = await hubWith(fakeTasks(), [say('一'), say('二'), say('三'), say('## 目标和要求\n- 无')], { compactAt: 50_000 });
  for (const text of ['第一句', '第二句', '第三句']) {
    await hub.send(board.id, { text });
    await settled(hub, board.id);
  }
  const { context } = await hub.view(board.id);
  assert.ok(context && context.used > 0 && context.limit === 50_000, JSON.stringify(context));
  await hub.condense(board.id);
  assert.equal((await hub.view(board.id)).context, null);
});

test('saved commands keep clear of the built-ins and of each other, and come back as saved', async () => {
  const { hub } = await hubWith(fakeTasks(), []);
  await assert.rejects(hub.saveCommands([{ name: '计划', prompt: 'x' }]), /内置命令/);
  await assert.rejects(hub.saveCommands([{ name: 'Plan', prompt: 'x' }]), /内置命令/);
  await assert.rejects(hub.saveCommands([{ name: '短 剧', prompt: 'x' }]), /不能有空格/);
  await assert.rejects(hub.saveCommands([{ name: '短剧', prompt: 'a' }, { name: '短剧', prompt: 'b' }]), /有两个命令/);
  await assert.rejects(hub.saveCommands([{ name: '短剧', prompt: '  ' }]), /内容是空的/);
  await assert.rejects(hub.saveCommands({ name: '短剧' }), /格式错误/);
  const saved = await hub.saveCommands([{ name: '/短剧', prompt: ' 做一部短剧：{输入} ' }]);
  assert.deepEqual(saved, [{ name: '短剧', prompt: '做一部短剧：{输入}' }]);
  assert.deepEqual(await hub.commands(), saved);
});

test('checkpoints for going back stay out of the snapshot list, and only the latest forty are kept', async () => {
  const board = await projects.create('checkpoints');
  await projects.createSnapshot(board.id, '用户存的');
  for (let i = 0; i < 42; i++) await projects.createSnapshot(board.id, 'checkpoint', { checkpoint: true });
  assert.deepEqual((await projects.listSnapshots(board.id)).map((s) => s.name), ['用户存的']);
  const files = readdirSync(join(process.env.DATA_DIR!, 'snapshots', board.id));
  assert.equal(files.length, 41);
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

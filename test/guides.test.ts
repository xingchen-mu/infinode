// The how-to guides the canvas assistant reads with read_guide.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUIDES } from '../server/agent/guides.ts';
import { systemPrompt } from '../server/agent/prompt.ts';
import { type CanvasTool, canvasTools } from '../server/agent/tools.ts';
import { setServerLang } from '../server/i18n.ts';

type Deps = Parameters<typeof canvasTools>[0];
type Writer = Parameters<typeof canvasTools>[1];
const tools = canvasTools({} as Deps, {} as Writer);
const readGuide = tools.find((t) => t.name === 'read_guide')!;
const ctx = { projectId: 'board00001' };

/** Every property name in a JSON Schema, nested ones included. */
function paramNames(schema: unknown, into = new Set<string>()): Set<string> {
  if (!schema || typeof schema !== 'object') return into;
  const s = schema as { properties?: Record<string, unknown>; items?: unknown };
  for (const [k, v] of Object.entries(s.properties ?? {})) {
    into.add(k);
    paramNames(v, into);
  }
  paramNames(s.items, into);
  return into;
}

test('read_guide gives the whole guide, or one section of it', async () => {
  const all = await readGuide.run({ name: 'short_drama' }, ctx);
  for (const s of GUIDES[0].sections) assert.ok(all.text.includes(s.text), s.id);
  const one = await readGuide.run({ name: 'short_drama', section: 'keyframes' }, ctx);
  assert.match(one.text, /^## 4\. 关键帧/);
  assert.ok(!one.text.includes('## 5. 视频'));
  await assert.rejects(readGuide.run({ name: 'short_drama', section: 'nope' }, ctx), /keyframes/);
  await assert.rejects(readGuide.run({ name: 'nope' }, ctx), /short_drama/);
  const refs = await readGuide.run({ name: 'qwen_image', section: 'i2i' }, ctx);
  assert.match(refs.text, /^## 带参考图/);
});

test('the guides and the system prompt only name tools and parameters that exist', () => {
  // H3 prompt fields, and the tags the runtime wraps messages in.
  const known = new Set<string>(['integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music', 'canvas_context', 'canvas_event']);
  for (const t of tools as CanvasTool[]) {
    known.add(t.name);
    paramNames(t.parameters, known);
  }
  for (const g of GUIDES) {
    known.add(g.id);
    g.sections.forEach((s) => known.add(s.id));
  }
  const texts = [...GUIDES.flatMap((g) => g.sections.map((s) => s.text)), systemPrompt(true)];
  const named = new Set(texts.flatMap((s) => s.match(/\b[a-z]+(?:_[a-z0-9]+)+\b/g) ?? []));
  assert.deepEqual([...named].filter((n) => !known.has(n)), []);
});

test('every H3 prompt in the video section is complete: first-frame line, then the three fields', () => {
  const video = GUIDES[0].sections.find((s) => s.id === 'video')!.text;
  const count = (re: RegExp) => video.match(re)?.length ?? 0;
  const examples = count(/^integrated_multimodal_description: \[Shot 1\]/gm);
  assert.ok(examples >= 3, 'the template and two examples');
  assert.equal(count(/^For the target video, at 0\.00 seconds into the target video, <Picture 1> \(from \[Shot 1\]\) is fully referenced\.$/gm), examples);
  assert.equal(count(/^overall_soundscape: /gm), examples);
  assert.equal(count(/^non_diegetic_music: /gm), examples);
});

test('the system prompt sends short dramas to the guide, and outside agents get the tool too', () => {
  assert.match(systemPrompt(true), /read_guide 读完 short_drama 手册/);
  assert.match(systemPrompt(true), /read_guide 读 qwen_image 手册/);
  assert.ok(canvasTools({} as Deps, {} as Writer, 'mcp').some((t) => t.name === 'read_guide'));
});

test('the panel shows which part of the guide was read, in the interface language', () => {
  setServerLang('en');
  try {
    assert.equal(readGuide.describe({ name: 'short_drama', section: 'shots' }), 'Short drama guide · Shot list');
    assert.equal(readGuide.describe({ name: 'short_drama' }), 'Short drama guide');
  } finally {
    setServerLang('zh');
  }
});

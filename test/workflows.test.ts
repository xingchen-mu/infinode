import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { CustomWorkflow } from '../shared/types.ts';
import { WorkflowFormatError, detectWorkflow, parseWorkflowJson } from '../server/workflows/custom.ts';
import { RequestError, buildWorkflow } from '../server/workflows/index.ts';

const file = (name: string, width = 1024, height = 1024) => ({ comfyName: name, width, height });
const nodesOf = (graph: Record<string, { class_type: string }>) => Object.values(graph).map((n) => n.class_type);
const textOf = (graph: Record<string, { inputs: Record<string, unknown> }>) => JSON.stringify(Object.values(graph).map((n) => n.inputs));
const preset = (name: string) => {
  const p = JSON.parse(readFileSync(new URL(`../presets/${name}.json`, import.meta.url), 'utf8'));
  return { id: `tpl_${p.id}`, name: p.name, kind: p.kind, graph: p.graph, inputs: p.inputs, outputs: p.outputs, createdAt: 0, updatedAt: 0 } as CustomWorkflow;
};

test('text to image follows the aspect ratio at about one megapixel', () => {
  const wf = buildWorkflow({ op: 'image.generate', model: 'qwen', prompt: '一只猫', aspect: '16:9', quality: '1k' }, { images: [] }, 42, () => undefined);
  assert.equal(wf.expected.kind, 'image');
  const { width, height } = wf.expected;
  assert.ok(Math.abs(width / height - 16 / 9) < 0.05 && width % 32 === 0 && height % 32 === 0);
  assert.ok(Math.abs((width * height) / 2 ** 20 - 1) < 0.15);
  assert.ok(wf.outputNodes.length > 0);
});

test('reference images are wired in and 图1 becomes the model tag', () => {
  const wf = buildWorkflow(
    { op: 'image.generate', model: 'qwen', prompt: '把图1的人放进图2', aspect: 'auto', quality: '1k', images: ['a', 'b'] },
    { images: [file('a.png'), file('b.png')] },
    1,
    () => undefined,
  );
  const text = textOf(wf.graph);
  assert.ok(text.includes('a.png') && text.includes('b.png'));
  assert.ok(text.includes('<image1>') && text.includes('<image2>'));
});

test('MiniMax reference video uses its node and <Picture n> tags', () => {
  const wf = buildWorkflow(
    { op: 'video.generate', model: 'minimax-ref', prompt: '@图1 在走路', aspect: '16:9', quality: '480p', duration: 5, images: ['a'] },
    { images: [file('a.png', 1376, 768)] },
    1,
    () => undefined,
  );
  assert.equal(wf.expected.kind, 'video');
  assert.ok(nodesOf(wf.graph).includes('MiniMaxH3ReferenceToVideo'));
  assert.ok(textOf(wf.graph).includes('<Picture 1>'));
});

test('bad requests fail before anything is queued', () => {
  assert.throws(() => buildWorkflow({ op: 'image.generate', model: 'qwen', prompt: ' ', aspect: '1:1', quality: '1k' }, { images: [] }, 1, () => undefined), RequestError);
  assert.throws(() => buildWorkflow({ op: 'image.generate', model: 'qwen', prompt: 'x', aspect: '50:1', quality: '1k' }, { images: [] }, 1, () => undefined), RequestError);
  assert.throws(() => buildWorkflow({ op: 'video.generate', model: 'minimax-ref', prompt: 'x', aspect: '16:9', quality: '480p', duration: 5 }, { images: [] }, 1, () => undefined), RequestError);
});

test('an imported workflow gets the prompt, seed and a new shape with the same pixel budget', () => {
  const wf = preset('qwen-image-2512');
  const built = buildWorkflow({ op: 'custom', workflow: wf.id, prompt: '海边的灯塔', aspect: '16:9' }, { images: [], videos: [] }, 7, () => wf);
  const input = (type: string) => wf.inputs.find((i) => i.type === type)!;
  const value = (type: string) => built.graph[input(type).node].inputs[input(type).field];
  assert.equal(value('prompt'), '海边的灯塔');
  assert.equal(value('seed'), 7);
  const w = Number(value('width'));
  const h = Number(value('height'));
  const base = Number(wf.graph[input('width').node].inputs[input('width').field]) * Number(wf.graph[input('height').node].inputs[input('height').field]);
  assert.ok(Math.abs(w / h - 16 / 9) < 0.05);
  assert.ok(Math.abs((w * h) / base - 1) < 0.1);
  // The stored workflow is not changed by a run.
  assert.notEqual(wf.graph[input('prompt').node].inputs[input('prompt').field], '海边的灯塔');
});

test('importing finds the prompt and the output of an exported graph', () => {
  const wf = preset('qwen-image-2512');
  const { graph } = parseWorkflowJson(wf.graph);
  const draft = detectWorkflow(graph);
  assert.equal(draft.workflow.kind, 'image');
  assert.ok(draft.workflow.inputs.some((i) => i.type === 'prompt'));
  assert.ok(draft.workflow.outputs.length > 0);
});

test('a UI-format workflow (not "Export (API)") is refused with a hint', () => {
  assert.throws(() => parseWorkflowJson({ nodes: [], links: [], version: 0.4 }), WorkflowFormatError);
});

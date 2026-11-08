import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtinCommand, expandCommand, parseCommand } from '../shared/commands.ts';

test('a /command is its name and the words after it; anything else is not a command', () => {
  assert.deepEqual(parseCommand('/计划 做一部短剧'), { name: '计划', rest: '做一部短剧' });
  assert.deepEqual(parseCommand('  /new  '), { name: 'new', rest: '' });
  assert.deepEqual(parseCommand('/短剧 第一行\n第二行'), { name: '短剧', rest: '第一行\n第二行' });
  assert.equal(parseCommand('把 /计划 写进去'), undefined);
  assert.equal(parseCommand('/a/b'), undefined);
  assert.equal(parseCommand('/'), undefined);
});

test('built-ins answer to their Chinese and English names', () => {
  assert.equal(builtinCommand('计划'), 'plan');
  assert.equal(builtinCommand('Plan'), 'plan');
  assert.equal(builtinCommand('整理'), 'condense');
  assert.equal(builtinCommand('new'), 'new');
  assert.equal(builtinCommand('短剧'), undefined);
});

test('a saved command takes the words after it in its slot, or else at the end', () => {
  const drama = { name: '短剧', prompt: '做一部三个镜头的短剧，故事是：{输入}。画风写实。' };
  assert.equal(expandCommand(drama, '女孩在等人'), '做一部三个镜头的短剧，故事是：女孩在等人。画风写实。');
  assert.equal(expandCommand({ name: 'tidy', prompt: 'Arrange: {input} and {input}' }, 'shots'), 'Arrange: shots and shots');
  assert.equal(expandCommand({ name: '检查', prompt: '看看选中的图有没有问题' }, '重点看手'), '看看选中的图有没有问题\n\n重点看手');
  assert.equal(expandCommand({ name: '检查', prompt: '看看选中的图有没有问题' }, ''), '看看选中的图有没有问题');
});

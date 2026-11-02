import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { translate } from '../shared/i18n.ts';
import { EN } from '../shared/locales/en.ts';
import { CJK, scanFile, sourceFiles } from './i18n-scan.ts';

// Everything the user reads goes through t(). The assistant's prompt, tool descriptions and tool results
// are for the model and stay in Chinese (server/agent, server/mcp.ts), so only their t() calls are checked.
const UI = (p: string) => p.startsWith('src/') || p.startsWith('server/workflows/') || (/^server\/[^/]+\.ts$/.test(p) && p !== 'server/mcp.ts');

function scan() {
  const keys = new Set<string>();
  const stray: string[] = [];
  for (const dir of ['src', 'server', 'shared']) {
    for (const file of sourceFiles(dir)) {
      if (file.startsWith('shared/locales/')) continue;
      const s = scanFile(file, UI(file));
      s.keys.forEach((k) => keys.add(k));
      stray.push(...s.stray);
    }
  }
  // Template names, descriptions, categories and input labels are shown through t() too.
  for (const f of readdirSync('presets')) {
    const p = JSON.parse(readFileSync(`presets/${f}`, 'utf8')) as { name: string; description?: string; category?: string; inputs: { label: string }[] };
    for (const s of [p.name, p.description, p.category, ...p.inputs.map((i) => i.label)]) if (s && CJK.test(s)) keys.add(s);
  }
  return { keys, stray };
}

const { keys, stray } = scan();
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

test('the interface has no Chinese outside t() and msg()', () => {
  assert.deepEqual(stray, []);
});

test('every message has an English translation without Chinese in it', () => {
  const untranslated = [...keys].filter((k) => CJK.test(translate('en', k, { n: 2 })));
  assert.deepEqual(untranslated, []);
});

test('translations keep the placeholders of their message', () => {
  for (const [zh, en] of Object.entries(EN)) {
    const want = placeholders(zh);
    (Array.isArray(en) ? en : [en]).forEach((form, i) => {
      const got = placeholders(form);
      // A singular may leave the number out: "Includes the selected item".
      const optional = Array.isArray(en) && i === 0 ? ['n'] : [];
      assert.ok(got.every((p) => want.includes(p)) && want.every((p) => got.includes(p) || optional.includes(p)), `${zh} → ${form}`);
    });
  }
});

test('the dictionary has no entries the code no longer uses', () => {
  assert.deepEqual(
    Object.keys(EN).filter((k) => !keys.has(k)),
    [],
  );
});

test('plurals, numbered labels and variables', () => {
  assert.equal(translate('en', '{n} 个节点', { n: 1 }), '1 item');
  assert.equal(translate('en', '{n} 个节点', { n: 3 }), '3 items');
  assert.equal(translate('en', '参考图2'), 'Reference image 2');
  assert.equal(translate('en', '用户自己起的名字'), '用户自己起的名字');
  assert.equal(translate('zh', '{n} 个节点', { n: 3 }), '3 个节点');
});

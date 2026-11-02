import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { COMMERCIAL_BLOCK, LICENSES, commercialBlock } from '../shared/licenses.ts';
import { REQUIREMENTS } from '../server/workflows/index.ts';

test('every built-in tool and official template has a license entry', () => {
  for (const key of Object.keys(REQUIREMENTS)) assert.ok(LICENSES[key], key);
  const dir = new URL('../presets/', import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const id = JSON.parse(readFileSync(new URL(f, dir), 'utf8')).id;
    assert.ok(LICENSES[`custom:tpl_${id}`], `presets/${f}`);
  }
});

test('commercial-only mode blocks research and non-commercial models, not conditional or Apache ones', () => {
  assert.ok(commercialBlock('image.generate:qwen')?.startsWith(COMMERCIAL_BLOCK));
  assert.ok(commercialBlock('custom:tpl_flux2-dev-t2i'));
  assert.equal(commercialBlock('image.generate:zimage'), undefined);
  assert.equal(commercialBlock('video.generate:minimax'), undefined);
  assert.equal(commercialBlock('custom:tpl_qwen-edit-2511'), undefined);
  // Imported workflows: the user's own call.
  assert.equal(commercialBlock('custom:my-workflow'), undefined);
});

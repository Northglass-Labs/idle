import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectScriptTags } from './script-tag-boundary.mjs';

test('inventories mixed-case and whitespace-closed script elements', () => {
  const result = inspectScriptTags([
    '<script src="/static/app.js"></script>',
    '<ScRiPt>globalThis.injected = true</SCRIPT   >',
  ].join('\n'));

  assert.equal(result.valid, true);
  assert.equal(result.tags.length, 2);
  assert.equal(result.tags[0].hasSource, true);
  assert.equal(result.tags[1].hasSource, false);
});

test('fails closed on an unclosed script element', () => {
  const result = inspectScriptTags('<script src="/static/app.js">');

  assert.equal(result.valid, false);
  assert.equal(result.tags.length, 0);
});

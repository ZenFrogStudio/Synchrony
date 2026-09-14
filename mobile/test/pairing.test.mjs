/**
 * `parseConnectorUrl` is the one gate a pasted or scanned QR payload passes
 * through before the phone fetches it, so its accept/reject line is pinned
 * here. Imports the compiled output from `../lib/pairing.js` — relative to
 * *this file once tsc has copied it into `dist-test/test/`* — so it resolves
 * to `dist-test/lib/pairing.js`, the same mirror trick `mcp.test.mjs` uses.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConnectorUrl } from '../lib/pairing.js';

test('accepts the exact shape hub-up prints', () => {
  const result = parseConnectorUrl('https://abc.trycloudflare.com/tok123/mcp');
  assert.deepEqual(result, { ok: true, url: 'https://abc.trycloudflare.com/tok123/mcp' });
});

test('accepts a trailing slash after /mcp', () => {
  const result = parseConnectorUrl('https://abc.trycloudflare.com/tok123/mcp/');
  assert.equal(result.ok, true);
});

test('trims surrounding whitespace', () => {
  const result = parseConnectorUrl('  https://abc.trycloudflare.com/tok123/mcp\n');
  assert.deepEqual(result, { ok: true, url: 'https://abc.trycloudflare.com/tok123/mcp' });
});

test('rejects http://', () => {
  const result = parseConnectorUrl('http://abc.trycloudflare.com/tok123/mcp');
  assert.equal(result.ok, false);
  assert.match(result.reason, /https:\/\//);
});

test('rejects paths that are not /<token>/mcp', () => {
  for (const path of ['/mcp', '/a/b/mcp', '/tok/other', '/', '']) {
    const result = parseConnectorUrl(`https://abc.trycloudflare.com${path}`);
    assert.equal(result.ok, false, `expected ${JSON.stringify(path)} to be rejected`);
    assert.match(result.reason, /<token>\/mcp/);
  }
});

test('rejects QR payloads that are not URLs at all', () => {
  for (const payload of ['just some text', '']) {
    const result = parseConnectorUrl(payload);
    assert.equal(result.ok, false, `expected ${JSON.stringify(payload)} to be rejected`);
    assert.match(result.reason, /does not look like a URL/);
  }
});

test('rejects a Wi-Fi QR payload (parses as a wifi: URL, fails the https check)', () => {
  const result = parseConnectorUrl('WIFI:S:foo;T:WPA;P:bar;;');
  assert.equal(result.ok, false);
  assert.match(result.reason, /https:\/\//);
});

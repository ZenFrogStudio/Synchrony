/**
 * Headless proof that `lib/mcp.ts` really speaks to `dist/hub.js`: spawns the
 * real hub against a throwaway fixture project (the same trick
 * `scripts/hub-smoke.mjs` uses one level up) and drives `McpClient` against
 * it, no mocks. Imports the compiled output from `../lib/mcp.js` — relative
 * to *this file once tsc has copied it into `dist-test/test/`* — so it
 * resolves to `dist-test/lib/mcp.js`, the same mirror `npm test` at the repo
 * root builds against `dist-test/`.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkHealth, McpClient, McpError } from '../lib/mcp.js';

// This file only ever runs compiled, from `mobile/dist-test/test/`, two
// directories deeper than its source at `mobile/test/` — so both roots are
// resolved relative to that copied location, not this source file's own path.
const COMPILED_DIR = path.dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = path.resolve(COMPILED_DIR, '../..');
const REPO_ROOT = path.resolve(MOBILE_ROOT, '..');
const HOST = '127.0.0.1';
const PORT = 7944;
const TOKEN = 'mobiletest';
const CONNECTOR_URL = `http://${HOST}:${PORT}/${TOKEN}/mcp`;
const INSTANCE = 'proj';

function log(message) {
  process.stdout.write(`[mcp-test] ${message}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `<tmp>/proj/.synchrony/` with the layout `ensureRoot` produces — no starter plan needed here. */
function buildFixture() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synchrony-mobile-test-'));
  const projectDir = path.join(tmpRoot, INSTANCE);
  const synchronyDir = path.join(projectDir, '.synchrony');
  for (const sub of ['plans', 'tasks', 'questions', 'requests', 'control', 'results', 'logs']) {
    fs.mkdirSync(path.join(synchronyDir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(synchronyDir, '.gitignore'), '*\n', 'utf8');
  return { tmpRoot, projectDir };
}

async function waitForHealth(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const info = await checkHealth(url);
      if (info.ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() >= deadline) {
      throw new Error('the hub never answered healthz');
    }
    await sleep(200);
  }
}

test('McpClient drives the real hub end-to-end over HTTP', async () => {
  const hubEntry = path.join(REPO_ROOT, 'dist', 'hub.js');
  if (!fs.existsSync(hubEntry)) {
    log('dist/hub.js is missing; building the repo root first (npm run compile)');
    execFileSync('npm', ['run', 'compile'], { cwd: REPO_ROOT, stdio: 'inherit', shell: true });
  }
  assert.ok(fs.existsSync(hubEntry), `${hubEntry} still does not exist after building`);

  const { tmpRoot, projectDir } = buildFixture();
  const hub = spawn(process.execPath, [hubEntry, '--folder', projectDir, '--port', String(PORT)], {
    cwd: REPO_ROOT,
    env: { ...process.env, SYNCHRONY_HUB_TOKEN: TOKEN, SYNCHRONY_HUB_HOST: HOST },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let hubOutput = '';
  hub.stdout.on('data', (chunk) => {
    hubOutput += chunk;
  });
  hub.stderr.on('data', (chunk) => {
    hubOutput += chunk;
  });
  let hubExited = false;
  hub.on('exit', () => {
    hubExited = true;
  });

  const cleanup = () => {
    if (!hubExited) hub.kill();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  };

  try {
    await waitForHealth(CONNECTOR_URL);
    log('hub answered healthz');

    const health = await checkHealth(CONNECTOR_URL);
    assert.equal(health.ok, true, 'checkHealth did not report ok');

    const client = new McpClient(CONNECTOR_URL);
    await client.initialize();
    log('initialized');

    const listed = await client.callJson('list_instances', {});
    assert.ok(Array.isArray(listed.instances), 'list_instances did not return an instances array');
    assert.ok(
      listed.instances.some((i) => i.instance === INSTANCE),
      'list_instances is missing the fixture instance'
    );
    log('list_instances sees the fixture instance');

    const captured = await client.callJson('add_task', { instance: INSTANCE, text: 'Mobile transport test task' });
    assert.ok(captured.captured, 'add_task did not return a captured file name');

    const tasks = await client.callJson('list_tasks', { instance: INSTANCE });
    assert.ok(
      tasks.some((t) => t.name === captured.captured),
      'the task captured by add_task is missing from list_tasks'
    );
    log('add_task round-trips through list_tasks');

    await assert.rejects(() => client.call('not_a_real_tool', {}), (err) => err instanceof McpError);
    log('calling an unknown tool throws McpError');
  } catch (err) {
    process.stderr.write(`[mcp-test] hub output so far:\n${hubOutput}\n`);
    throw err;
  } finally {
    cleanup();
  }
});

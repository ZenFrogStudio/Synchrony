#!/usr/bin/env node
/**
 * Headless end-to-end proof that the hub's full tool surface works: spawns
 * `dist/hub.js` against a throwaway fixture project, drives raw JSON-RPC 2.0
 * over `fetch` the way a real MCP client would, and checks both the RPC
 * replies and the files/`state.json` the calls are supposed to leave behind.
 *
 * Plain Node, no dependencies, so it can run in CI without a browser or an
 * MCP SDK client on the calling side — the same reason `mcp-clients.test.ts`
 * drives the stdio server's config tables rather than a real client.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const PORT = 7943;
const TOKEN = 'smoketest';
const BASE_URL = `http://${HOST}:${PORT}`;
const MCP_URL = `${BASE_URL}/${TOKEN}/mcp`;
const PROTOCOL_VERSION = '2025-06-18';
const INSTANCE = 'proj';

/** Every tool this stage adds to the hub, beyond what Stage 2 already shipped. */
const NEW_TOOLS = [
  'read_instance',
  'read_transcript',
  'read_log',
  'request_status',
  'update_series',
  'unschedule_series',
  'run_now',
  'rerun_run',
  'dismiss_run',
  'create_plan',
  'save_plan',
  'rename_plan',
  'archive_plan',
  'edit_task',
  'delete_task',
  'run_task',
  'chain_plans',
  'cancel_run',
  'update_setting'
];
const EXISTING_TOOLS = [
  'list_instances',
  'list_tasks',
  'list_plans',
  'read_plan',
  'list_schedule',
  'list_runs',
  'list_questions',
  'add_task',
  'request_plan',
  'schedule_plan',
  'answer_question'
];

let nextId = 1;
let sessionId;

function log(message) {
  process.stdout.write(`[hub-smoke] ${message}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function waitForHealth(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE_URL}/healthz`);
      if (res.ok) {
        const body = await res.json();
        if (body.ok) return;
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() >= deadline) {
      throw new Error('the hub never answered /healthz');
    }
    await sleep(200);
  }
}

/**
 * One JSON-RPC 2.0 exchange over `fetch`, the protocol `hub.ts`'s header
 * documents: a bearer-free, path-token URL, `Accept` naming both response
 * shapes the SDK may choose, and an `mcp-session-id` echoed back once the
 * server has handed one out. `notification: true` sends a body with no `id`
 * and does not wait for a result — just that the transport accepted it.
 */
async function rpc(method, params, { notification = false } = {}) {
  const body = {
    jsonrpc: '2.0',
    method,
    ...(params !== undefined ? { params } : {}),
    ...(notification ? {} : { id: nextId++ })
  };
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream'
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });

  const returnedSession = res.headers.get('mcp-session-id');
  if (returnedSession) sessionId = returnedSession;

  if (notification) {
    if (!res.ok) {
      throw new Error(`notification ${method} failed: HTTP ${res.status}`);
    }
    await res.arrayBuffer(); // Drain the body; there is nothing to parse.
    return undefined;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} failed: HTTP ${res.status} ${text}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  let message;
  if (contentType.includes('application/json')) {
    message = await res.json();
  } else if (contentType.includes('text/event-stream')) {
    const text = await res.text();
    const dataLines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'));
    if (!dataLines.length) {
      throw new Error(`${method}: SSE body carried no "data:" line`);
    }
    message = JSON.parse(dataLines[dataLines.length - 1].slice('data:'.length).trim());
  } else {
    throw new Error(`${method}: unexpected content-type "${contentType}"`);
  }

  if (message.error) {
    throw new Error(`${method} returned a JSON-RPC error: ${JSON.stringify(message.error)}`);
  }
  return message.result;
}

async function callTool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args });
  if (result?.isError) {
    throw new Error(`tool ${name} refused: ${result.content?.[0]?.text ?? JSON.stringify(result)}`);
  }
  return result;
}

const toolText = (result) => result.content?.[0]?.text ?? '';
const toolJson = (result) => JSON.parse(toolText(result));

/** Builds `<tmp>/proj/.synchrony/` with the layout `ensureRoot` produces, plus a starter plan. */
function buildFixture() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synchrony-hub-smoke-'));
  const projectDir = path.join(tmpRoot, INSTANCE);
  const synchronyDir = path.join(projectDir, '.synchrony');

  for (const sub of ['plans', 'tasks', 'questions', 'requests', 'control', 'results', 'logs']) {
    fs.mkdirSync(path.join(synchronyDir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(synchronyDir, '.gitignore'), '*\n', 'utf8');
  fs.writeFileSync(
    path.join(synchronyDir, 'plans', 'starter.md'),
    '# Starter\n\nReply with exactly the word OK and stop. Do not edit any files.\n',
    'utf8'
  );

  return { tmpRoot, projectDir, synchronyDir };
}

async function main() {
  const { tmpRoot, projectDir, synchronyDir } = buildFixture();
  log(`fixture project at ${projectDir}`);

  const hubEntry = path.join(ROOT, 'dist', 'hub.js');
  if (!fs.existsSync(hubEntry)) {
    throw new Error(`${hubEntry} does not exist — run "npm run compile" first`);
  }

  const hub = spawn(process.execPath, [hubEntry, '--folder', projectDir, '--port', String(PORT)], {
    cwd: ROOT,
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
    if (!hubExited) {
      hub.kill();
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  };

  try {
    await waitForHealth();
    log('hub answered /healthz');

    const init = await rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'synchrony-hub-smoke', version: '0.0.0' }
    });
    assert.equal(init?.serverInfo?.name, 'synchrony-hub', `unexpected initialize result: ${JSON.stringify(init)}`);
    await rpc('notifications/initialized', {}, { notification: true });
    log(`initialized (session: ${sessionId ?? '(none — stateless serving)'})`);

    const toolsList = await rpc('tools/list', {});
    const names = new Set(toolsList.tools.map((t) => t.name));
    for (const name of [...EXISTING_TOOLS, ...NEW_TOOLS]) {
      assert.ok(names.has(name), `tools/list is missing "${name}"`);
    }
    log(`tools/list carries all ${EXISTING_TOOLS.length + NEW_TOOLS.length} expected tools`);

    const stateFile = path.join(synchronyDir, 'state.json');

    // ---- create_plan, save_plan, schedule_plan ----
    const created = toolJson(
      await callTool('create_plan', { instance: INSTANCE, title: 'Smoke Plan One', body: '# One\n\nSay hi.\n' })
    );
    assert.equal(created.name, 'smoke-plan-one.md');

    await callTool('save_plan', { instance: INSTANCE, name: created.name, text: '# One\n\nSay hi, updated.\n' });

    const scheduled = toolJson(
      await callTool('schedule_plan', {
        instance: INSTANCE,
        name: created.name,
        at: new Date(Date.now() + 3_600_000).toISOString()
      })
    );
    assert.ok(scheduled.id, 'schedule_plan did not return a series id');
    log('create_plan, save_plan and schedule_plan round-trip');

    // ---- read_instance: the plan and series appear ----
    const instancePayload = toolJson(await callTool('read_instance', { instance: INSTANCE }));
    assert.ok(instancePayload.plans.some((p) => p.name === created.name), 'read_instance is missing the created plan');
    assert.ok(instancePayload.series.some((s) => s.id === scheduled.id), 'read_instance is missing the scheduled series');
    log('read_instance sees the created plan and series');

    // ---- update_series: disable ----
    const updated = toolJson(await callTool('update_series', { instance: INSTANCE, id: scheduled.id, patch: { enabled: false } }));
    assert.equal(updated.enabled, false, 'update_series did not disable the series');

    // ---- run_now: a manual pending run lands in state.json ----
    const ran = toolJson(await callTool('run_now', { instance: INSTANCE, seriesId: scheduled.id }));
    assert.ok(ran.run?.id, 'run_now did not return a run');
    let diskState = readJson(stateFile);
    assert.ok(
      diskState.runs.some((r) => r.id === ran.run.id && r.status === 'pending'),
      'run_now’s run is not a pending run in state.json'
    );
    log('update_series and run_now land on disk');

    // ---- chain_plans across two more created plans ----
    const planTwo = toolJson(await callTool('create_plan', { instance: INSTANCE, title: 'Smoke Plan Two' }));
    const planThree = toolJson(await callTool('create_plan', { instance: INSTANCE, title: 'Smoke Plan Three' }));
    const chained = toolJson(
      await callTool('chain_plans', {
        instance: INSTANCE,
        names: [planTwo.name, planThree.name],
        startIso: new Date(Date.now() + 3_600_000).toISOString(),
        gapMinutes: 5,
        stopOnFailure: false
      })
    );
    assert.equal(chained.series.length, 2, 'chain_plans did not return two series');
    diskState = readJson(stateFile);
    const chainedIds = chained.series.map((s) => s.id);
    const secondOnDisk = diskState.series.find((s) => s.id === chainedIds[1]);
    assert.equal(secondOnDisk?.chain?.after, chainedIds[0], 'chain_plans did not link the second plan after the first on disk');
    log('chain_plans links land on disk');

    // ---- unschedule_series ----
    await callTool('unschedule_series', { instance: INSTANCE, id: scheduled.id });
    diskState = readJson(stateFile);
    assert.ok(!diskState.series.some((s) => s.id === scheduled.id), 'unschedule_series left the series in state.json');
    log('unschedule_series removes the series from disk');

    // ---- add_task -> edit_task -> run_task -> delete_task, on a second task ----
    const taskOne = toolJson(await callTool('add_task', { instance: INSTANCE, text: 'Smoke task one' }));
    assert.ok(fs.existsSync(path.join(synchronyDir, 'tasks', taskOne.captured)), 'add_task did not write the task file');

    const taskTwo = toolJson(await callTool('add_task', { instance: INSTANCE, text: 'Smoke task two' }));
    await callTool('edit_task', { instance: INSTANCE, name: taskTwo.captured, text: 'Smoke task two, edited' });

    const taskRun = toolJson(await callTool('run_task', { instance: INSTANCE, name: taskTwo.captured }));
    assert.ok(taskRun.series?.id, 'run_task did not return a series');
    diskState = readJson(stateFile);
    assert.ok(
      diskState.series.some((s) => s.id === taskRun.series.id && s.spent === true),
      'run_task did not leave a spent series in state.json'
    );
    assert.ok(
      fs.existsSync(path.join(synchronyDir, 'tasks', taskTwo.captured)),
      'run_task removed the task from the inbox — it should stay until deleted by hand'
    );

    await callTool('delete_task', { instance: INSTANCE, name: taskTwo.captured });
    assert.ok(!fs.existsSync(path.join(synchronyDir, 'tasks', taskTwo.captured)), 'delete_task left the task in the inbox');
    assert.ok(
      fs.existsSync(path.join(synchronyDir, 'archive', 'tasks', taskTwo.captured)),
      'delete_task did not move the task into the archive'
    );
    log('add_task, edit_task, run_task and delete_task round-trip on disk');

    // ---- read_plan, archive_plan ----
    const body = toolText(await callTool('read_plan', { instance: INSTANCE, name: created.name }));
    assert.match(body, /Say hi, updated/, 'read_plan did not return the saved text');

    await callTool('archive_plan', { instance: INSTANCE, name: created.name });
    assert.ok(!fs.existsSync(path.join(synchronyDir, 'plans', created.name)), 'archive_plan left the plan in the library');
    assert.ok(
      fs.existsSync(path.join(synchronyDir, 'archive', 'plans', created.name)),
      'archive_plan did not move the plan into the archive'
    );
    log('read_plan and archive_plan round-trip on disk');

    log('all checks passed');
  } catch (err) {
    process.stderr.write(`[hub-smoke] hub output so far:\n${hubOutput}\n`);
    throw err;
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  process.stderr.write(`[hub-smoke] FAILED: ${err?.stack ?? err}\n`);
  process.exitCode = 1;
});

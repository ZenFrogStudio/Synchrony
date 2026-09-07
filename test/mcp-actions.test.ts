import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { holdLock } from '../src/lock';
import { captureTask, requestPlan, scheduleSeries, summarizeInstance } from '../src/mcp-actions';
import { listUnclaimed } from '../src/requests';
import { ChronosPaths, ensureRoot, pathsFor } from '../src/roots';
import { readState } from '../src/state-file';

/**
 * The actions both doors (stdio server, HTTP hub) share, driven without a
 * transport against a real project folder in a temp directory.
 */

let folder: string;
let paths: ChronosPaths;
const inAnHour = () => new Date(Date.now() + 60 * 60_000).toISOString();

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chronos-actions-'));
  paths = pathsFor(folder);
});

afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

describe('mcp-actions — captureTask', () => {
  it('should_write_the_task_into_the_inbox_and_create_the_tree', () => {
    const out = captureTask(paths, '  Fix the lock  ');
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.value.name, 'fix-the-lock.md');
      assert.equal(fs.readFileSync(out.value.filePath, 'utf8'), 'Fix the lock\n');
    }
    assert.ok(fs.existsSync(paths.requests), 'ensureRoot creates the requests dir too');
  });

  it('should_refuse_an_empty_task_without_touching_the_disk', () => {
    const out = captureTask(paths, '   ');
    assert.equal(out.ok, false);
    assert.equal(fs.existsSync(paths.root), false);
  });
});

describe('mcp-actions — scheduleSeries', () => {
  beforeEach(() => {
    ensureRoot(paths);
    fs.writeFileSync(path.join(paths.plans, 'nightly.md'), '# nightly\n', 'utf8');
  });

  it('should_append_a_series_for_a_library_plan', () => {
    const at = inAnHour();
    const out = scheduleSeries(paths, { name: 'nightly.md', at, agent: 'codex', model: 'gpt-x' }, {
      maxRetries: 3,
      allowPermissionMode: false
    });

    assert.equal(out.ok, true, JSON.stringify(out));
    const { series } = readState(paths.state).state;
    assert.equal(series.length, 1);
    assert.equal(series[0].fileName, 'nightly.md');
    assert.equal(series[0].agent, 'codex');
    assert.equal(series[0].model, 'gpt-x');
    assert.equal(series[0].cwd, folder);
    assert.equal(series[0].permissionMode, 'auto');
  });

  it('should_refuse_a_plan_that_is_not_in_the_library_and_write_nothing', () => {
    const out = scheduleSeries(paths, { name: 'missing.md', at: inAnHour() }, {
      maxRetries: 3,
      allowPermissionMode: false
    });
    assert.equal(out.ok, false);
    assert.equal(fs.existsSync(paths.state), false);
  });

  it('should_refuse_a_path_disguised_as_a_name', () => {
    const out = scheduleSeries(paths, { name: '../../etc/passwd', at: inAnHour() }, {
      maxRetries: 3,
      allowPermissionMode: false
    });
    assert.equal(out.ok, false);
  });

  it('should_refuse_permissionMode_on_the_agent_door', () => {
    const out = scheduleSeries(
      paths,
      { name: 'nightly.md', at: inAnHour(), permissionMode: 'bypassPermissions' },
      { maxRetries: 3, allowPermissionMode: false }
    );
    assert.equal(out.ok, false);
    assert.equal(fs.existsSync(paths.state), false);
  });

  it('should_honour_permissionMode_on_the_owner_door', () => {
    const out = scheduleSeries(
      paths,
      { name: 'nightly.md', at: inAnHour(), permissionMode: 'acceptEdits' },
      { maxRetries: 3, allowPermissionMode: true }
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(readState(paths.state).state.series[0].permissionMode, 'acceptEdits');
  });

  it('should_refuse_a_permissionMode_that_is_not_one_the_cli_knows', () => {
    const out = scheduleSeries(
      paths,
      { name: 'nightly.md', at: inAnHour(), permissionMode: 'god' },
      { maxRetries: 3, allowPermissionMode: true }
    );
    assert.equal(out.ok, false);
  });

  it('should_say_when_no_window_is_watching', () => {
    const out = scheduleSeries(paths, { name: 'nightly.md', at: inAnHour() }, {
      maxRetries: 3,
      allowPermissionMode: true
    });
    assert.equal(out.ok, true);
    if (out.ok) assert.ok(out.value.queued, 'a folder with no lock is queued');
  });

  it('should_stay_quiet_when_a_window_holds_the_lock', () => {
    holdLock(paths.lock, 'window-a', Date.now(), 90_000);
    const out = scheduleSeries(paths, { name: 'nightly.md', at: inAnHour() }, {
      maxRetries: 3,
      allowPermissionMode: true
    });
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.value.queued, undefined);
  });
});

describe('mcp-actions — requestPlan', () => {
  it('should_refuse_a_task_that_is_not_in_the_inbox', () => {
    ensureRoot(paths);
    const out = requestPlan(paths, { task: 'nope.md' });
    assert.equal(out.ok, false);
    assert.deepEqual(listUnclaimed(paths.requests), []);
  });

  it('should_write_a_request_for_an_inbox_task_and_report_liveness', () => {
    captureTask(paths, 'Fix the lock');
    const out = requestPlan(paths, { task: 'fix-the-lock.md', series: true, source: 'test' });

    assert.equal(out.ok, true, JSON.stringify(out));
    if (out.ok) {
      assert.equal(out.value.live, false);
      assert.deepEqual(listUnclaimed(paths.requests), [out.value.request.id]);
      assert.equal(out.value.request.series, true);
    }
  });
});

describe('mcp-actions — summarizeInstance', () => {
  it('should_count_series_by_state_and_name_the_next_armed_one', () => {
    ensureRoot(paths);
    fs.writeFileSync(path.join(paths.plans, 'a.md'), '# a\n', 'utf8');
    fs.writeFileSync(path.join(paths.plans, 'b.md'), '# b\n', 'utf8');
    const soon = new Date(Date.now() + 30 * 60_000).toISOString();
    const later = new Date(Date.now() + 120 * 60_000).toISOString();
    scheduleSeries(paths, { name: 'b.md', at: later }, { maxRetries: 3, allowPermissionMode: true });
    scheduleSeries(paths, { name: 'a.md', at: soon }, { maxRetries: 3, allowPermissionMode: true });
    captureTask(paths, 'one task');

    const summary = summarizeInstance(paths);

    assert.equal(summary.live, false);
    assert.equal(summary.counts.armed, 2);
    assert.equal(summary.next?.plan, 'a.md');
    assert.equal(summary.tasks, 1);
    assert.equal(summary.running, null);
    assert.equal(summary.pendingRequests, 0);
  });

  it('should_report_live_when_the_lock_is_fresh', () => {
    ensureRoot(paths);
    holdLock(paths.lock, 'window-a', Date.now(), 90_000);
    assert.equal(summarizeInstance(paths).live, true);
  });
});

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { holdLock } from '../src/lock';
import {
  appendToChainAction,
  archivePlanAction,
  captureTask,
  chainPlansAction,
  createPlanAction,
  deleteTaskAction,
  dismissRun,
  editSeries,
  editTaskAction,
  removeSeries,
  renamePlanAction,
  requestPlan,
  rerunRun,
  runSeriesNow,
  runTaskAction,
  savePlanAction,
  scheduleSeries,
  summarizeInstance
} from '../src/mcp-actions';
import { listUnclaimed } from '../src/requests';
import { SynchronyPaths, ensureRoot, pathsFor } from '../src/roots';
import { readState, updateState } from '../src/state-file';
import { TaskRun, TaskSeries } from '../src/types';

/**
 * The actions both doors (stdio server, HTTP hub) share, driven without a
 * transport against a real project folder in a temp directory.
 */

let folder: string;
let paths: SynchronyPaths;
const inAnHour = () => new Date(Date.now() + 60 * 60_000).toISOString();

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'synchrony-actions-'));
  paths = pathsFor(folder);
});

afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

/** A minimal, valid series, for tests that seed state directly. */
function fixtureSeries(overrides: Partial<TaskSeries> = {}): TaskSeries {
  return {
    id: 'series-1',
    filePath: path.join(paths.plans, 'nightly.md'),
    fileName: 'nightly.md',
    cwd: folder,
    permissionMode: 'auto',
    recurrence: null,
    nextRunAt: inAnHour(),
    enabled: true,
    maxRetries: 3,
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function fixtureRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run-1',
    seriesId: 'series-1',
    scheduledAt: inAnHour(),
    status: 'pending',
    attempt: 1,
    ...overrides
  };
}

/** Seeds `state.json` directly, for tests that need specific ids/links. */
function seedState(series: TaskSeries[], runs: TaskRun[] = []): void {
  ensureRoot(paths);
  updateState(paths.state, (current) => {
    current.series = series;
    current.runs = runs;
  });
}

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

  it('should_refuse_a_second_series_for_a_plan_already_on_the_schedule', () => {
    const opts = { maxRetries: 3, allowPermissionMode: false };
    const first = scheduleSeries(paths, { name: 'nightly.md', at: inAnHour() }, opts);
    assert.equal(first.ok, true, JSON.stringify(first));

    const second = scheduleSeries(paths, { name: 'nightly.md', at: inAnHour() }, opts);
    assert.equal(second.ok, false);
    if (!second.ok) assert.match(second.reason, /already on the schedule/);
    assert.equal(readState(paths.state).state.series.length, 1, 'the second call wrote nothing');
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

  it('should_report_missed_runs_and_the_rolling_seven_day_cost', () => {
    const now = Date.now();
    seedState(
      [fixtureSeries()],
      [
        fixtureRun({ id: 'r-missed', status: 'missed', missedAt: new Date(now).toISOString() }),
        fixtureRun({
          id: 'r-recent',
          status: 'completed',
          costUsd: 2,
          finishedAt: new Date(now - 24 * 60 * 60_000).toISOString()
        }),
        fixtureRun({
          id: 'r-old',
          status: 'completed',
          costUsd: 5,
          finishedAt: new Date(now - 10 * 24 * 60 * 60_000).toISOString()
        })
      ]
    );

    const summary = summarizeInstance(paths, now);
    assert.equal(summary.missedRuns, 1);
    assert.equal(summary.costLast7Days, 2);
  });
});

describe('mcp-actions — editSeries', () => {
  beforeEach(() => {
    seedState([fixtureSeries()]);
  });

  it('should_apply_a_legal_patch_and_return_the_updated_series', () => {
    const out = editSeries(paths, 'series-1', { enabled: false }, { allowPermissionMode: false });
    assert.equal(out.ok, true, JSON.stringify(out));
    if (out.ok) assert.equal(out.value.enabled, false);
    assert.equal(readState(paths.state).state.series[0].enabled, false);
  });

  it('should_drop_a_disallowed_field_while_still_applying_the_rest', () => {
    const out = editSeries(
      paths,
      'series-1',
      { bogus: 'nonsense', enabled: false },
      { allowPermissionMode: false }
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    if (out.ok) assert.equal(out.value.enabled, false);
  });

  it('should_strip_permissionMode_when_not_allowed', () => {
    const out = editSeries(
      paths,
      'series-1',
      { permissionMode: 'bypassPermissions', enabled: false },
      { allowPermissionMode: false }
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    const series = readState(paths.state).state.series[0];
    assert.equal(series.permissionMode, 'auto');
    assert.equal(series.enabled, false);
  });

  it('should_honour_permissionMode_when_allowed', () => {
    const out = editSeries(
      paths,
      'series-1',
      { permissionMode: 'acceptEdits' },
      { allowPermissionMode: true }
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(readState(paths.state).state.series[0].permissionMode, 'acceptEdits');
  });

  it('should_refuse_a_chain_link_that_would_make_a_loop', () => {
    seedState([
      fixtureSeries({ id: 'a', fileName: 'a.md' }),
      fixtureSeries({
        id: 'b',
        fileName: 'b.md',
        spent: true,
        chain: { after: 'a', delayMinutes: 5, stopOnFailure: false }
      })
    ]);

    const out = editSeries(
      paths,
      'a',
      { chain: { after: 'b', delayMinutes: 5, stopOnFailure: false } },
      { allowPermissionMode: true }
    );
    assert.equal(out.ok, false);
  });

  it('should_refuse_a_missing_series', () => {
    const out = editSeries(paths, 'nope', { enabled: false }, { allowPermissionMode: false });
    assert.equal(out.ok, false);
  });
});

describe('mcp-actions — removeSeries', () => {
  it('should_splice_a_chain_when_its_predecessor_is_removed', () => {
    seedState([
      fixtureSeries({ id: 'a', fileName: 'a.md' }),
      fixtureSeries({
        id: 'b',
        fileName: 'b.md',
        spent: true,
        chain: { after: 'a', delayMinutes: 10, stopOnFailure: true }
      })
    ]);

    const out = removeSeries(paths, 'a');
    assert.equal(out.ok, true, JSON.stringify(out));
    if (out.ok) assert.equal(out.value.fileName, 'a.md');

    const { series } = readState(paths.state).state;
    assert.equal(series.length, 1);
    assert.equal(series[0].id, 'b');
    // `a` had no chain of its own to inherit, so `b` is unlinked and switched off.
    assert.equal(series[0].chain, undefined);
    assert.equal(series[0].enabled, false);
  });

  it('should_refuse_a_missing_series', () => {
    seedState([fixtureSeries()]);
    const out = removeSeries(paths, 'nope');
    assert.equal(out.ok, false);
    assert.equal(readState(paths.state).state.series.length, 1);
  });
});

describe('mcp-actions — runSeriesNow', () => {
  it('should_append_a_manual_pending_run', () => {
    seedState([fixtureSeries()]);
    const out = runSeriesNow(paths, 'series-1');
    assert.equal(out.ok, true, JSON.stringify(out));

    const { runs } = readState(paths.state).state;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].seriesId, 'series-1');
    assert.equal(runs[0].status, 'pending');
    assert.equal(runs[0].manual, true);
  });

  it('should_refuse_a_missing_series', () => {
    seedState([]);
    const out = runSeriesNow(paths, 'nope');
    assert.equal(out.ok, false);
  });

  it('should_remove_the_dismissed_run_in_the_same_write', () => {
    seedState([fixtureSeries()], [fixtureRun({ id: 'missed-1', status: 'missed' })]);
    const out = runSeriesNow(paths, 'series-1', { dismissRunId: 'missed-1' });
    assert.equal(out.ok, true, JSON.stringify(out));

    const { runs } = readState(paths.state).state;
    assert.equal(runs.length, 1);
    assert.equal(runs.some((r) => r.id === 'missed-1'), false);
    assert.equal(runs[0].manual, true);
  });
});

describe('mcp-actions — rerunRun', () => {
  it('should_queue_a_new_manual_run_for_the_runs_series', () => {
    seedState([fixtureSeries()], [fixtureRun({ id: 'run-1', status: 'completed' })]);
    const out = rerunRun(paths, 'run-1');
    assert.equal(out.ok, true, JSON.stringify(out));

    const { runs } = readState(paths.state).state;
    assert.equal(runs.length, 2);
    assert.ok(runs.some((r) => r.manual && r.status === 'pending'));
  });

  it('should_refuse_a_missing_run', () => {
    seedState([fixtureSeries()]);
    const out = rerunRun(paths, 'nope');
    assert.equal(out.ok, false);
  });

  it('should_refuse_a_run_whose_series_is_gone', () => {
    seedState([], [fixtureRun({ id: 'run-1', seriesId: 'ghost', status: 'completed' })]);
    const out = rerunRun(paths, 'run-1');
    assert.equal(out.ok, false);
  });
});

describe('mcp-actions — dismissRun', () => {
  it('should_remove_a_finished_run', () => {
    seedState([fixtureSeries()], [fixtureRun({ id: 'run-1', status: 'completed' })]);
    const out = dismissRun(paths, 'run-1');
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(readState(paths.state).state.runs.length, 0);
  });

  it('should_refuse_a_run_that_is_still_running', () => {
    seedState([fixtureSeries()], [fixtureRun({ id: 'run-1', status: 'running' })]);
    const out = dismissRun(paths, 'run-1');
    assert.equal(out.ok, false);
    assert.equal(readState(paths.state).state.runs.length, 1);
  });

  it('should_refuse_a_missing_run', () => {
    seedState([fixtureSeries()]);
    const out = dismissRun(paths, 'nope');
    assert.equal(out.ok, false);
  });
});

describe('mcp-actions — plan CRUD', () => {
  it('should_create_a_plan_with_a_title', () => {
    const out = createPlanAction(paths, 'My New Plan');
    assert.equal(out.ok, true, JSON.stringify(out));
    if (out.ok) assert.equal(out.value.name, 'my-new-plan.md');
  });

  it('should_refuse_an_empty_title', () => {
    const out = createPlanAction(paths, '   ');
    assert.equal(out.ok, false);
  });

  it('should_save_text_to_an_existing_plan', () => {
    ensureRoot(paths);
    fs.writeFileSync(path.join(paths.plans, 'nightly.md'), '# old\n', 'utf8');
    const out = savePlanAction(paths, 'nightly.md', '# new body\n');
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(fs.readFileSync(path.join(paths.plans, 'nightly.md'), 'utf8'), '# new body\n');
  });

  it('should_refuse_a_plan_body_over_the_one_megabyte_cap', () => {
    ensureRoot(paths);
    fs.writeFileSync(path.join(paths.plans, 'nightly.md'), '# old\n', 'utf8');
    const tooBig = 'x'.repeat(1_000_001);
    const out = savePlanAction(paths, 'nightly.md', tooBig);
    assert.equal(out.ok, false);
    assert.equal(fs.readFileSync(path.join(paths.plans, 'nightly.md'), 'utf8'), '# old\n');
  });

  it('should_repoint_a_series_pointing_at_the_renamed_plan', () => {
    ensureRoot(paths);
    const before = path.join(paths.plans, 'old-name.md');
    fs.writeFileSync(before, '# old name\n', 'utf8');
    seedState([fixtureSeries({ filePath: before, fileName: 'old-name.md' })]);

    const out = renamePlanAction(paths, 'old-name.md', 'New Title');
    assert.equal(out.ok, true, JSON.stringify(out));

    const series = readState(paths.state).state.series[0];
    if (out.ok) {
      assert.equal(series.filePath, out.value.filePath);
      assert.equal(series.fileName, out.value.name);
    }
    assert.notEqual(series.fileName, 'old-name.md');
  });

  it('should_remove_pointing_series_and_splice_chains_then_archive_the_file', () => {
    ensureRoot(paths);
    const target = path.join(paths.plans, 'target.md');
    fs.writeFileSync(target, '# target\n', 'utf8');
    fs.writeFileSync(path.join(paths.plans, 'follower.md'), '# follower\n', 'utf8');

    seedState([
      fixtureSeries({ id: 'a', filePath: target, fileName: 'target.md' }),
      fixtureSeries({
        id: 'b',
        filePath: path.join(paths.plans, 'follower.md'),
        fileName: 'follower.md',
        spent: true,
        chain: { after: 'a', delayMinutes: 5, stopOnFailure: true }
      })
    ]);

    const out = archivePlanAction(paths, 'target.md');
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(path.join(paths.archivedPlans, 'target.md')), true);

    const { series } = readState(paths.state).state;
    assert.equal(series.length, 1);
    assert.equal(series[0].id, 'b');
    assert.equal(series[0].chain, undefined);
    assert.equal(series[0].enabled, false);
  });
});

describe('mcp-actions — task inbox', () => {
  it('should_save_text_to_an_existing_task', () => {
    const created = captureTask(paths, 'Fix the lock');
    assert.equal(created.ok, true);
    const out = editTaskAction(paths, 'fix-the-lock.md', 'Fix the lock properly\n');
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(
      fs.readFileSync(path.join(paths.tasks, 'fix-the-lock.md'), 'utf8'),
      'Fix the lock properly\n'
    );
  });

  it('should_refuse_a_task_body_over_the_one_megabyte_cap', () => {
    captureTask(paths, 'Fix the lock');
    const out = editTaskAction(paths, 'fix-the-lock.md', 'x'.repeat(1_000_001));
    assert.equal(out.ok, false);
  });

  it('should_archive_a_task_file', () => {
    captureTask(paths, 'Fix the lock');
    const out = deleteTaskAction(paths, 'fix-the-lock.md');
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(fs.existsSync(path.join(paths.tasks, 'fix-the-lock.md')), false);
    assert.equal(fs.existsSync(path.join(paths.archivedTasks, 'fix-the-lock.md')), true);
  });

  it('should_refuse_deleting_a_missing_task', () => {
    ensureRoot(paths);
    const out = deleteTaskAction(paths, 'nope.md');
    assert.equal(out.ok, false);
  });

  it('should_move_the_task_into_the_library_and_queue_a_spent_manual_run', () => {
    captureTask(paths, 'Fix the lock');
    const out = runTaskAction(paths, 'fix-the-lock.md');
    assert.equal(out.ok, true, JSON.stringify(out));
    if (out.ok) {
      assert.equal(out.value.series.spent, true);
      assert.equal(out.value.series.permissionMode, 'auto');
      assert.match(out.value.note, /cleared from the inbox/);
    }

    // The action never deletes the task file itself — the leading window's
    // settle pass does that once the run completes, by way of `taskName`.
    assert.equal(fs.existsSync(path.join(paths.tasks, 'fix-the-lock.md')), true);
    assert.equal(fs.existsSync(path.join(paths.plans, 'fix-the-lock.md')), true);

    const { series, runs } = readState(paths.state).state;
    assert.equal(series.length, 1);
    assert.equal(series[0].maxRetries, 0);
    assert.equal(series[0].cwd, folder);
    assert.equal(series[0].taskName, 'fix-the-lock.md');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].manual, true);
    assert.equal(runs[0].seriesId, series[0].id);
  });

  it('should_refuse_running_a_missing_task', () => {
    ensureRoot(paths);
    const out = runTaskAction(paths, 'nope.md');
    assert.equal(out.ok, false);
  });
});

describe('mcp-actions — chainPlansAction', () => {
  beforeEach(() => {
    ensureRoot(paths);
    for (const name of ['a.md', 'b.md', 'c.md']) {
      fs.writeFileSync(path.join(paths.plans, name), `# ${name}\n`, 'utf8');
    }
  });

  it('should_chain_three_plans_with_correct_links_and_gaps', () => {
    const start = inAnHour();
    const out = chainPlansAction(
      paths,
      {
        names: ['a.md', 'b.md', 'c.md'],
        startIso: start,
        gapMinutes: 15,
        stopOnFailure: true
      },
      { maxRetries: 3 }
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    if (!out.ok) return;

    const [a, b, c] = out.value.series;
    assert.equal(a.plan, 'a.md');
    assert.equal(a.nextRunAt, start);
    assert.equal(a.runsAfter, undefined);

    assert.equal(b.plan, 'b.md');
    assert.equal(b.runsAfter?.seriesId, a.id);
    assert.equal(b.runsAfter?.delayMinutes, 15);
    assert.equal(b.spent, true);

    assert.equal(c.plan, 'c.md');
    assert.equal(c.runsAfter?.seriesId, b.id);

    assert.equal(readState(paths.state).state.series.length, 3);
  });

  it('should_refuse_duplicate_plan_names', () => {
    const out = chainPlansAction(
      paths,
      { names: ['a.md', 'a.md'], startIso: inAnHour(), gapMinutes: 10, stopOnFailure: false },
      { maxRetries: 3 }
    );
    assert.equal(out.ok, false);
    assert.equal(readState(paths.state).state.series.length, 0);
  });

  it('should_refuse_a_gap_outside_the_allowed_range', () => {
    const out = chainPlansAction(
      paths,
      { names: ['a.md', 'b.md'], startIso: inAnHour(), gapMinutes: 1441, stopOnFailure: false },
      { maxRetries: 3 }
    );
    assert.equal(out.ok, false);
  });

  it('should_splice_the_old_chain_when_a_middle_plan_is_taken_into_a_new_one', () => {
    fs.writeFileSync(path.join(paths.plans, 'd.md'), '# d.md\n', 'utf8');
    const first = chainPlansAction(
      paths,
      { names: ['a.md', 'b.md', 'c.md'], startIso: inAnHour(), gapMinutes: 15, stopOnFailure: true },
      { maxRetries: 3 }
    );
    assert.equal(first.ok, true, JSON.stringify(first));
    if (!first.ok) return;
    const [a] = first.value.series;

    const out = chainPlansAction(
      paths,
      { names: ['d.md', 'b.md'], startIso: inAnHour(), gapMinutes: 5, stopOnFailure: false },
      { maxRetries: 3 }
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    if (!out.ok) return;
    assert.equal(out.value.note, undefined, 'nothing was switched off');

    // c was waiting on b; it now waits on a instead of on a plan that runs
    // inside the new chain.
    const stored = readState(paths.state).state.series;
    const c = stored.find((s) => s.fileName === 'c.md');
    assert.equal(c?.chain?.after, a.id);
    assert.equal(c?.enabled, true);
    assert.equal(stored.length, 4);
  });

  it('should_switch_off_the_old_follower_when_a_chains_head_is_taken', () => {
    fs.writeFileSync(path.join(paths.plans, 'd.md'), '# d.md\n', 'utf8');
    const first = chainPlansAction(
      paths,
      { names: ['a.md', 'b.md'], startIso: inAnHour(), gapMinutes: 15, stopOnFailure: true },
      { maxRetries: 3 }
    );
    assert.equal(first.ok, true, JSON.stringify(first));

    const out = chainPlansAction(
      paths,
      { names: ['d.md', 'a.md'], startIso: inAnHour(), gapMinutes: 5, stopOnFailure: false },
      { maxRetries: 3 }
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    if (!out.ok) return;
    assert.match(out.value.note ?? '', /no longer scheduled/);

    const b = readState(paths.state).state.series.find((s) => s.fileName === 'b.md');
    assert.equal(b?.chain, undefined);
    assert.equal(b?.enabled, false);
  });
});

describe('mcp-actions — appendToChainAction', () => {
  const opts = { maxRetries: 3 };

  /** A two-plan chain a → b, built the way a user would build it. */
  function chainAB(gapMinutes = 20) {
    const out = chainPlansAction(
      paths,
      { names: ['a.md', 'b.md'], startIso: inAnHour(), gapMinutes, stopOnFailure: false },
      opts
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    if (!out.ok) throw new Error('unreachable');
    return { a: out.value.series[0], b: out.value.series[1] };
  }

  beforeEach(() => {
    ensureRoot(paths);
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) {
      fs.writeFileSync(path.join(paths.plans, name), `# ${name}\n`, 'utf8');
    }
  });

  it('should_append_behind_the_tail_given_any_member_id', () => {
    const { a, b } = chainAB(20);

    const out = appendToChainAction(paths, { seriesId: a.id, name: 'c.md' }, opts);

    assert.equal(out.ok, true, JSON.stringify(out));
    if (!out.ok) return;
    assert.equal(out.value.series.plan, 'c.md');
    assert.equal(out.value.series.runsAfter?.seriesId, b.id);
    assert.equal(out.value.series.runsAfter?.delayMinutes, 20);
    assert.equal(out.value.series.spent, true);
  });

  it('should_reuse_an_existing_series_and_clear_its_repeat_rule', () => {
    const { a } = chainAB();
    const scheduled = scheduleSeries(
      paths,
      { name: 'c.md', at: inAnHour(), repeat: 'daily' },
      { maxRetries: 3, allowPermissionMode: false }
    );
    assert.equal(scheduled.ok, true, JSON.stringify(scheduled));
    if (!scheduled.ok) return;

    const out = appendToChainAction(paths, { seriesId: a.id, name: 'c.md' }, opts);

    assert.equal(out.ok, true, JSON.stringify(out));
    if (!out.ok) return;
    assert.equal(out.value.series.id, scheduled.value.series.id);
    assert.equal(out.value.series.recurrence, null);
    const stored = readState(paths.state).state.series.find((s) => s.fileName === 'c.md');
    assert.ok(stored?.repeatEndedAt, 'the end of the repeat rule is stamped');
    assert.equal(readState(paths.state).state.series.length, 3);
  });

  it('should_mint_a_series_for_an_unscheduled_plan', () => {
    const { a } = chainAB();

    const out = appendToChainAction(paths, { seriesId: a.id, name: 'c.md' }, opts);

    assert.equal(out.ok, true, JSON.stringify(out));
    const stored = readState(paths.state).state.series.find((s) => s.fileName === 'c.md');
    assert.equal(stored?.spent, true);
    assert.equal(stored?.cwd, folder);
    assert.equal(stored?.maxRetries, 3);
  });

  it('should_refuse_a_plan_already_in_the_chain', () => {
    const { a } = chainAB();

    for (const name of ['a.md', 'b.md']) {
      const out = appendToChainAction(paths, { seriesId: a.id, name }, opts);
      assert.equal(out.ok, false, name);
    }
    assert.equal(readState(paths.state).state.series.length, 2);
  });

  it('should_refuse_a_plan_that_is_in_another_chain', () => {
    const { a } = chainAB();
    const other = chainPlansAction(
      paths,
      { names: ['c.md', 'd.md'], startIso: inAnHour(), gapMinutes: 5, stopOnFailure: true },
      opts
    );
    assert.equal(other.ok, true, JSON.stringify(other));

    const out = appendToChainAction(paths, { seriesId: a.id, name: 'd.md' }, opts);

    assert.equal(out.ok, false);
  });

  it('should_refuse_an_unknown_member_id', () => {
    chainAB();

    const out = appendToChainAction(paths, { seriesId: 'nope', name: 'c.md' }, opts);

    assert.equal(out.ok, false);
    assert.equal(readState(paths.state).state.series.length, 2);
  });

  it('should_refuse_a_plan_that_is_not_in_the_library', () => {
    const { a } = chainAB();

    const out = appendToChainAction(paths, { seriesId: a.id, name: 'missing.md' }, opts);

    assert.equal(out.ok, false);
  });
});

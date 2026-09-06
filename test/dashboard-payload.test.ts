import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
  DASHBOARD_SCHEMA_VERSION,
  FAILURE_WINDOW_MS,
  InstanceFacts,
  MAX_LISTED,
  buildInstancePayload,
  instancesDir
} from '../src/dashboard-payload';
import { DAILY, TaskRun, TaskSeries } from '../src/types';

/**
 * The heartbeat's shape: what each window claims to be doing, and which of its
 * work belongs in which column. Tested here rather than in the browser, where
 * nothing can reach it.
 */

const NOW = Date.parse('2026-09-07T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function series(overrides: Partial<TaskSeries> = {}): TaskSeries {
  return {
    id: 'series-1',
    filePath: 'D:\\repo\\.chronos\\plans\\refactor.md',
    fileName: 'refactor.md',
    cwd: 'D:\\repo',
    permissionMode: 'acceptEdits',
    recurrence: null,
    nextRunAt: at(HOUR),
    enabled: true,
    maxRetries: 3,
    createdAt: at(-24 * HOUR),
    ...overrides
  };
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run-1',
    seriesId: 'series-1',
    scheduledAt: at(-30 * MINUTE),
    status: 'completed',
    attempt: 1,
    finishedAt: at(-25 * MINUTE),
    ...overrides
  };
}

function build(overrides: Partial<InstanceFacts> = {}) {
  return buildInstancePayload({
    instanceId: '4321-abc123',
    processId: 4321,
    startedAt: at(-2 * HOUR),
    nowMs: NOW,
    status: 'active',
    workspaceFolder: 'D:\\repo',
    workspaceName: 'repo',
    activeFolder: 'D:\\repo',
    schedulerLeader: true,
    libraryPath: 'D:\\repo\\.chronos\\plans',
    resultsPath: 'D:\\repo\\.chronos\\results',
    costLast7Days: 0,
    series: [series()],
    runs: [],
    ...overrides
  });
}

describe('dashboard payload — identity', () => {
  it('should_stamp_the_schema_version_and_the_heartbeat_time', () => {
    const payload = build();

    assert.equal(payload.schemaVersion, DASHBOARD_SCHEMA_VERSION);
    assert.equal(payload.lastHeartbeatAt, new Date(NOW).toISOString());
  });

  it('should_report_the_active_folder_separately_from_the_window_root', () => {
    const payload = build({ workspaceFolder: 'D:\\root', activeFolder: 'D:\\root\\packages\\api' });

    assert.equal(payload.workspaceFolder, 'D:\\root');
    assert.equal(payload.activeFolder, 'D:\\root\\packages\\api');
  });

  it('should_carry_scheduler_leadership_so_two_windows_on_one_folder_are_tellable_apart', () => {
    assert.equal(build({ schedulerLeader: true }).schedulerLeader, true);
    assert.equal(build({ schedulerLeader: false }).schedulerLeader, false);
  });

  it('should_take_the_seven_day_cost_from_the_store_rather_than_recomputing_it', () => {
    // Deliberately inconsistent with the runs below: the store's figure is the
    // one the manager shows, and the dashboard must not disagree with it.
    const payload = build({
      costLast7Days: 12.5,
      runs: [run({ costUsd: 999 })]
    });

    assert.equal(payload.costLast7Days, 12.5);
  });

  it('should_mark_a_closing_heartbeat_stopped', () => {
    assert.equal(build({ status: 'stopped' }).status, 'stopped');
  });
});

describe('dashboard payload — counts', () => {
  it('should_count_a_paused_series_out_of_the_schedule', () => {
    const payload = build({
      series: [series({ id: 'on' }), series({ id: 'off', enabled: false })]
    });

    assert.equal(payload.counts.scheduled, 1);
  });

  it('should_count_a_spent_one_shot_out_of_the_schedule', () => {
    const payload = build({
      series: [series({ id: 'live' }), series({ id: 'fired', spent: true })]
    });

    assert.equal(payload.counts.scheduled, 1);
  });

  it('should_count_running_pending_and_missed_runs_separately', () => {
    const payload = build({
      runs: [
        run({ id: 'a', status: 'running', startedAt: at(-5 * MINUTE), finishedAt: undefined }),
        run({ id: 'b', status: 'pending', finishedAt: undefined }),
        run({ id: 'c', status: 'missed', missedAt: at(-2 * HOUR), finishedAt: undefined })
      ]
    });

    assert.equal(payload.counts.running, 1);
    assert.equal(payload.counts.pending, 1);
    assert.equal(payload.counts.missed, 1);
  });

  it('should_count_only_failures_inside_the_recent_window', () => {
    const payload = build({
      runs: [
        run({ id: 'fresh', status: 'failed', finishedAt: at(-2 * HOUR) }),
        run({ id: 'old', status: 'failed', finishedAt: at(-FAILURE_WINDOW_MS - MINUTE) })
      ]
    });

    assert.equal(payload.counts.failedRecent, 1);
    assert.deepEqual(
      payload.failures.map((f) => f.runId),
      ['fresh']
    );
  });
});

describe('dashboard payload — what goes in which column', () => {
  it('should_list_a_running_run_as_active_work', () => {
    const payload = build({
      runs: [run({ status: 'running', startedAt: at(-5 * MINUTE), finishedAt: undefined })]
    });

    assert.equal(payload.activeRuns.length, 1);
    assert.equal(payload.activeRuns[0].runId, 'run-1');
    assert.equal(payload.activeRuns[0].planTitle, 'refactor', 'the .md suffix is display noise');
    assert.equal(payload.activeRuns[0].at, at(-5 * MINUTE), 'ordered by when it started');
  });

  it('should_treat_a_run_due_now_and_waiting_for_a_slot_as_queued_work', () => {
    // `buildActivity` files this under "already happened" — its time has passed
    // — but on an operations board it is work that has not started yet.
    // Paused, so the series' own next occurrence is not in the list too and
    // the queued run is the only thing this can be reading.
    const payload = build({
      series: [series({ enabled: false })],
      runs: [run({ status: 'pending', scheduledAt: at(-MINUTE), finishedAt: undefined })]
    });

    assert.deepEqual(
      payload.upcoming.map((e) => e.runId),
      ['run-1']
    );
    assert.equal(payload.recent.length, 0);
  });

  it('should_order_queued_and_scheduled_work_soonest_first', () => {
    const payload = build({
      series: [series({ id: 'later', nextRunAt: at(6 * HOUR) })],
      runs: [
        run({ id: 'due-now', seriesId: 'later', status: 'pending', scheduledAt: at(-MINUTE), finishedAt: undefined }),
        run({ id: 'retry', seriesId: 'later', status: 'pending', scheduledAt: at(HOUR), finishedAt: undefined })
      ]
    });

    assert.deepEqual(
      payload.upcoming.map((e) => e.runId ?? e.seriesId),
      ['due-now', 'retry', 'later']
    );
  });

  it('should_answer_next_run_with_a_future_occurrence_not_a_run_already_overdue', () => {
    const payload = build({
      series: [series({ nextRunAt: at(2 * HOUR) })],
      runs: [run({ status: 'pending', scheduledAt: at(-30 * MINUTE), finishedAt: undefined })]
    });

    assert.equal(payload.nextRunAt, at(2 * HOUR));
  });

  it('should_leave_next_run_absent_when_nothing_is_due', () => {
    const payload = build({ series: [series({ enabled: false })] });

    assert.equal(payload.nextRunAt, undefined);
  });

  it('should_keep_only_finished_and_missed_runs_in_recent', () => {
    const payload = build({
      runs: [
        run({ id: 'done', status: 'completed', finishedAt: at(-10 * MINUTE) }),
        run({ id: 'gone', status: 'missed', missedAt: at(-20 * MINUTE), finishedAt: undefined }),
        run({ id: 'going', status: 'running', startedAt: at(-MINUTE), finishedAt: undefined })
      ]
    });

    assert.deepEqual(
      payload.recent.map((e) => e.runId),
      ['done', 'gone'],
      'newest first, and nothing still in flight'
    );
  });

  it('should_list_missed_runs_of_their_own_rather_than_leaving_them_to_be_filtered_out', () => {
    // A missed run days old has fallen off the end of `recent`, and an
    // unanswered missed run is the thing the board exists to surface.
    const stale = run({ id: 'stale-miss', status: 'missed', missedAt: at(-72 * HOUR), finishedAt: undefined });
    const noise = Array.from({ length: MAX_LISTED }, (_unused, index) =>
      run({ id: `done-${index}`, finishedAt: at(-index * MINUTE) })
    );

    const payload = build({ runs: [stale, ...noise] });

    assert.equal(payload.recent.length, MAX_LISTED);
    assert.ok(!payload.recent.some((e) => e.runId === 'stale-miss'), 'crowded out of recent');
    assert.deepEqual(
      payload.missed.map((e) => e.runId),
      ['stale-miss']
    );
  });

  it('should_cap_every_list_so_a_heartbeat_stays_a_status_file', () => {
    const many = Array.from({ length: MAX_LISTED + 12 }, (_unused, index) =>
      run({ id: `run-${index}`, status: 'running', startedAt: at(-index * MINUTE), finishedAt: undefined })
    );

    const payload = build({
      series: [series({ recurrence: { daysOfWeek: DAILY, timeLocal: '09:00' } })],
      runs: [
        ...many,
        ...Array.from({ length: MAX_LISTED + 5 }, (_unused, index) =>
          run({ id: `past-${index}`, finishedAt: at(-index * HOUR) })
        )
      ]
    });

    assert.equal(payload.upcoming.length <= MAX_LISTED, true);
    assert.equal(payload.recent.length, MAX_LISTED);
    // The count still tells the truth about what was left out.
    assert.equal(payload.counts.running, many.length);
  });
});

describe('dashboard payload — run detail', () => {
  it('should_carry_the_outcome_cost_and_attempt_of_a_finished_run', () => {
    const payload = build({
      runs: [run({ status: 'failed', attempt: 3, costUsd: 0.42, finishedAt: at(-MINUTE) })]
    });

    assert.equal(payload.recent[0].status, 'failed');
    assert.equal(payload.recent[0].attempt, 3);
    assert.equal(payload.recent[0].costUsd, 0.42);
  });

  it('should_truncate_error_text_rather_than_carrying_a_whole_stack_trace', () => {
    const payload = build({
      runs: [run({ status: 'failed', lastError: 'x'.repeat(5000), finishedAt: at(-MINUTE) })]
    });

    const error = payload.recent[0].error as string;
    assert.ok(error.length < 260, `error text was ${error.length} characters`);
    assert.ok(error.endsWith('...'));
  });

  it('should_name_a_run_whose_plan_has_been_deleted_rather_than_dropping_it', () => {
    const payload = build({
      series: [],
      runs: [run({ seriesId: 'vanished', status: 'failed', finishedAt: at(-MINUTE) })]
    });

    assert.equal(payload.recent[0].planTitle, 'Removed plan');
  });

  it('should_leave_a_future_occurrence_without_run_detail', () => {
    const payload = build();

    assert.equal(payload.upcoming[0].runId, undefined);
    assert.equal(payload.upcoming[0].status, undefined);
  });
});

describe('dashboard payload — where heartbeats live', () => {
  it('should_put_every_window_in_one_shared_directory_under_the_home_folder', () => {
    assert.equal(
      instancesDir('D:\\Users\\dev'),
      path.join('D:\\Users\\dev', '.chronos-dashboard', 'instances')
    );
  });
});

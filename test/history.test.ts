import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { jobState, pruneRuns, pruneSeries } from '../src/history';
import {
  DAILY,
  MAX_MISSED_RUNS,
  MAX_RECENT_RUNS,
  MAX_SPENT_SERIES,
  RunStatus,
  TaskRun,
  TaskSeries
} from '../src/types';

/**
 * The only place Chronos deletes something the user might still want, so the
 * rules are asserted rather than assumed.
 */

const NOW = Date.parse('2026-07-26T12:00:00.000Z');
const MINUTE = 60_000;

/** `n` runs of one status, oldest first, so index order is age order. */
function many(status: RunStatus, count: number, prefix: string): TaskRun[] {
  return Array.from({ length: count }, (_, i) => {
    const at = new Date(NOW - (count - i) * MINUTE).toISOString();
    const run: TaskRun = {
      id: `${prefix}-${i}`,
      seriesId: 'series-1',
      scheduledAt: at,
      status,
      attempt: 1
    };
    if (status === 'missed') {
      return { ...run, missedAt: at };
    }
    return { ...run, finishedAt: at };
  });
}

function series(overrides: Partial<TaskSeries> = {}): TaskSeries {
  return {
    id: 'series-1',
    filePath: '/plans/nightly.md',
    fileName: 'nightly.md',
    cwd: '/work/project',
    permissionMode: 'auto',
    recurrence: null,
    nextRunAt: '2026-08-09T02:00:00.000Z',
    enabled: true,
    maxRetries: 3,
    createdAt: '2026-08-08T12:00:00.000Z',
    ...overrides
  };
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run-1',
    seriesId: 'series-1',
    scheduledAt: '2026-08-09T02:00:00.000Z',
    status: 'completed',
    attempt: 1,
    ...overrides
  };
}

function spentSeries(count: number, prefix: string): TaskSeries[] {
  return Array.from({ length: count }, (_, i) => {
    const at = new Date(NOW - (count - i) * MINUTE).toISOString();
    return series({
      id: `${prefix}-${i}`,
      filePath: `/plans/${prefix}-${i}.md`,
      fileName: `${prefix}-${i}.md`,
      nextRunAt: at,
      spent: true
    });
  });
}

function completedRunsFor(seriesList: readonly TaskSeries[]): TaskRun[] {
  return seriesList.map((s) =>
    run({
      id: `run-${s.id}`,
      seriesId: s.id,
      scheduledAt: s.nextRunAt,
      finishedAt: s.nextRunAt
    })
  );
}

const idsOf = (runs: TaskRun[]) => runs.map((r) => r.id);
const seriesIdsOf = (series: TaskSeries[]) => series.map((s) => s.id);
const countOf = (runs: TaskRun[], status: RunStatus) =>
  runs.filter((r) => r.status === status).length;

describe('history — finished runs', () => {
  it('should_keep_everything_while_under_the_cap', () => {
    const runs = many('completed', 5, 'done');

    assert.deepEqual(idsOf(pruneRuns(runs)), idsOf(runs));
  });

  it('should_cap_finished_runs_at_the_limit', () => {
    const runs = many('completed', MAX_RECENT_RUNS + 20, 'done');

    assert.equal(countOf(pruneRuns(runs), 'completed'), MAX_RECENT_RUNS);
  });

  it('should_discard_the_oldest_finished_runs_not_the_newest', () => {
    const runs = many('completed', MAX_RECENT_RUNS + 1, 'done');

    const kept = idsOf(pruneRuns(runs));

    assert.ok(!kept.includes('done-0'), 'the oldest goes');
    assert.ok(kept.includes(`done-${MAX_RECENT_RUNS}`), 'the newest stays');
  });

  it('should_count_cancelled_and_failed_runs_against_the_same_cap', () => {
    const runs = [
      ...many('completed', 30, 'done'),
      ...many('failed', 30, 'bad'),
      ...many('cancelled', 30, 'stopped')
    ];

    assert.equal(pruneRuns(runs).length, MAX_RECENT_RUNS);
  });
});

describe('history — missed runs', () => {
  it('should_cap_missed_runs_on_their_own_more_generous_limit', () => {
    // The unbounded case: a catch-up decision nobody ever answers.
    const runs = many('missed', MAX_MISSED_RUNS + 20, 'missed');

    assert.equal(countOf(pruneRuns(runs), 'missed'), MAX_MISSED_RUNS);
  });

  it('should_not_let_finished_runs_push_out_a_missed_one', () => {
    // A missed run is still waiting for a decision; a completed one is history.
    const runs = [...many('completed', MAX_RECENT_RUNS + 50, 'done'), ...many('missed', 3, 'missed')];

    const kept = pruneRuns(runs);

    assert.equal(countOf(kept, 'missed'), 3);
    assert.equal(countOf(kept, 'completed'), MAX_RECENT_RUNS);
  });

  it('should_order_missed_runs_by_when_they_were_missed', () => {
    const runs = many('missed', MAX_MISSED_RUNS + 1, 'missed');

    const kept = idsOf(pruneRuns(runs));

    assert.ok(!kept.includes('missed-0'));
    assert.ok(kept.includes(`missed-${MAX_MISSED_RUNS}`));
  });
});

describe('history — runs still in flight', () => {
  it('should_never_drop_a_pending_run_however_much_history_there_is', () => {
    // Dropping one would cancel scheduled work with no trace.
    const pending = many('pending', 200, 'queued').map((r) => ({ ...r, finishedAt: undefined }));
    const runs = [...many('completed', MAX_RECENT_RUNS + 100, 'done'), ...pending];

    assert.equal(countOf(pruneRuns(runs), 'pending'), 200);
  });

  it('should_never_drop_a_running_run', () => {
    const running = many('running', 10, 'live').map((r) => ({ ...r, finishedAt: undefined }));
    const runs = [...many('completed', MAX_RECENT_RUNS + 100, 'done'), ...running];

    assert.equal(countOf(pruneRuns(runs), 'running'), 10);
  });
});

describe('jobState', () => {
  it('should_report_in_flight_when_no_run_has_been_recorded_yet', () => {
    // The series is written first and the run a tick later. Reading that gap as
    // finished would clear a task whose job had not started.
    const runs: TaskRun[] = [];

    assert.equal(jobState(runs), 'in-flight');
  });

  it('should_report_in_flight_while_a_run_is_pending_or_running', () => {
    const pending = many('pending', 1, 'queued');
    const running = many('running', 1, 'live');

    assert.equal(jobState(pending), 'in-flight');
    assert.equal(jobState(running), 'in-flight');
  });

  it('should_report_completed_when_a_run_completed', () => {
    const runs = many('completed', 1, 'done');

    assert.equal(jobState(runs), 'completed');
  });

  it('should_report_stopped_when_every_run_failed_or_was_cancelled_or_missed', () => {
    const runs = [
      ...many('failed', 1, 'bad'),
      ...many('cancelled', 1, 'stopped'),
      ...many('missed', 1, 'missed')
    ];

    assert.equal(jobState(runs), 'stopped');
  });

  it('should_report_in_flight_when_a_completed_run_sits_beside_a_pending_one', () => {
    // Otherwise a task is cleared out from under work still queued for it.
    const runs = [...many('completed', 1, 'done'), ...many('pending', 1, 'queued')];

    assert.equal(jobState(runs), 'in-flight');
  });
});

describe('history — spent one-shot series', () => {
  it('should_keep_every_spent_one_shot_while_under_the_cap', () => {
    const schedule = spentSeries(5, 'spent');
    const runs = completedRunsFor(schedule);

    assert.deepEqual(seriesIdsOf(pruneSeries(schedule, runs)), seriesIdsOf(schedule));
  });

  it('should_cap_spent_one_shots_at_the_limit', () => {
    const schedule = spentSeries(MAX_SPENT_SERIES + 20, 'spent');
    const runs = completedRunsFor(schedule);

    assert.equal(pruneSeries(schedule, runs).filter((s) => s.spent === true).length, MAX_SPENT_SERIES);
  });

  it('should_drop_the_oldest_spent_one_shots_not_the_newest', () => {
    const schedule = spentSeries(MAX_SPENT_SERIES + 1, 'spent');
    const runs = completedRunsFor(schedule);

    const kept = seriesIdsOf(pruneSeries(schedule, runs));

    assert.ok(!kept.includes('spent-0'), 'the oldest goes');
    assert.ok(kept.includes(`spent-${MAX_SPENT_SERIES}`), 'the newest stays');
  });

  it('should_never_drop_a_series_that_still_repeats_however_many_there_are', () => {
    const schedule = spentSeries(MAX_SPENT_SERIES + 20, 'daily').map((s) => ({
      ...s,
      recurrence: { daysOfWeek: DAILY, timeLocal: '02:00' }
    }));
    const runs = completedRunsFor(schedule);

    assert.equal(pruneSeries(schedule, runs).length, schedule.length);
  });

  it('should_never_drop_a_one_shot_that_has_not_fired_yet', () => {
    const spent = spentSeries(MAX_SPENT_SERIES + 20, 'spent');
    const waiting = [
      series({ id: 'waiting-absent', spent: undefined }),
      series({ id: 'waiting-false', spent: false })
    ];
    const runs = completedRunsFor([...spent, ...waiting]);

    const kept = seriesIdsOf(pruneSeries([...spent, ...waiting], runs));

    assert.ok(kept.includes('waiting-absent'));
    assert.ok(kept.includes('waiting-false'));
  });

  it('should_never_drop_a_plan_parked_in_a_chain', () => {
    // A follower waits as spent until the series before it finishes.
    const spent = spentSeries(MAX_SPENT_SERIES + 20, 'spent');
    const parked = series({
      id: 'parked',
      spent: true,
      chain: { after: 'head', delayMinutes: 15, stopOnFailure: true }
    });
    const runs = completedRunsFor([...spent, parked]);

    const kept = seriesIdsOf(pruneSeries([...spent, parked], runs));

    assert.ok(kept.includes('parked'));
  });

  it('should_never_drop_a_plan_another_series_is_chained_after', () => {
    // The head has no chain link of its own; only the follower names it.
    const spent = spentSeries(MAX_SPENT_SERIES + 20, 'spent');
    const head = series({ id: 'head', spent: true, nextRunAt: '2026-07-25T02:00:00.000Z' });
    const follower = series({
      id: 'follower',
      spent: true,
      chain: { after: 'head', delayMinutes: 15, stopOnFailure: true }
    });
    const runs = completedRunsFor([...spent, head, follower]);

    const kept = seriesIdsOf(pruneSeries([...spent, head, follower], runs));

    assert.ok(kept.includes('head'));
  });

  it('should_never_drop_a_series_whose_run_is_pending', () => {
    // A pending run means deleting the series would delete scheduled work.
    const spent = spentSeries(MAX_SPENT_SERIES + 20, 'spent');
    const pending = series({ id: 'pending-series', spent: true });
    const runs = [
      ...completedRunsFor(spent),
      run({
        id: 'pending-run',
        seriesId: pending.id,
        scheduledAt: pending.nextRunAt,
        status: 'pending'
      })
    ];

    const kept = seriesIdsOf(pruneSeries([...spent, pending], runs));

    assert.ok(kept.includes('pending-series'));
  });

  it('should_never_drop_a_series_whose_run_is_running', () => {
    const spent = spentSeries(MAX_SPENT_SERIES + 20, 'spent');
    const running = series({ id: 'running-series', spent: true });
    const runs = [
      ...completedRunsFor(spent),
      run({
        id: 'running-run',
        seriesId: running.id,
        scheduledAt: running.nextRunAt,
        status: 'running',
        startedAt: running.nextRunAt
      })
    ];

    const kept = seriesIdsOf(pruneSeries([...spent, running], runs));

    assert.ok(kept.includes('running-series'));
  });

  it('should_never_drop_a_series_with_no_runs_at_all', () => {
    // Inbox-created tasks are born spent before the run record exists.
    const spent = spentSeries(MAX_SPENT_SERIES + 20, 'spent');
    const bornSpent = series({ id: 'born-spent', spent: true });
    const runs = completedRunsFor(spent);

    const kept = seriesIdsOf(pruneSeries([...spent, bornSpent], runs));

    assert.ok(kept.includes('born-spent'));
  });

  it('should_leave_the_run_records_of_a_dropped_series_alone', () => {
    const schedule = spentSeries(MAX_SPENT_SERIES + 1, 'spent');
    const runs = completedRunsFor(schedule);
    const before = idsOf(runs);

    pruneSeries(schedule, runs);

    assert.ok(!seriesIdsOf(pruneSeries(schedule, runs)).includes('spent-0'));
    assert.deepEqual(idsOf(runs), before);
  });
});

describe('history — leaving the input alone', () => {
  it('should_not_mutate_the_array_it_was_given', () => {
    const runs = many('completed', MAX_RECENT_RUNS + 5, 'done');
    const before = idsOf(runs);

    pruneRuns(runs);

    assert.deepEqual(idsOf(runs), before, 'sorting must not reorder the caller’s array');
  });

  it('should_not_mutate_the_series_or_run_arrays_it_was_given', () => {
    const schedule = spentSeries(MAX_SPENT_SERIES + 5, 'spent');
    const runs = completedRunsFor(schedule);
    const beforeSeries = seriesIdsOf(schedule);
    const beforeRuns = idsOf(runs);

    pruneSeries(schedule, runs);

    assert.deepEqual(seriesIdsOf(schedule), beforeSeries, 'sorting must not reorder the series array');
    assert.deepEqual(idsOf(runs), beforeRuns, 'series pruning must not reorder run history');
  });
});

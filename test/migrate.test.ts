import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { migrate } from '../src/migrate';
import { SynchronyState, SCHEMA_VERSION, TaskRun, TaskSeries } from '../src/types';

/**
 * The store used to demand exact version equality, so bumping SCHEMA_VERSION
 * would have moved every user's tasks to a backup key and started them empty.
 * These tests exist so that can never quietly happen again.
 */

function v1Series(overrides: Partial<TaskSeries> = {}): TaskSeries {
  return {
    id: 'series-1',
    filePath: 'D:\\plans\\refactor.md',
    fileName: 'refactor.md',
    cwd: 'D:\\repo',
    permissionMode: 'acceptEdits',
    recurrence: null,
    nextRunAt: '2026-07-26T12:00:00.000Z',
    enabled: true,
    maxRetries: 3,
    createdAt: '2026-07-26T11:00:00.000Z',
    ...overrides
  };
}

function v1Run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run-1',
    seriesId: 'series-1',
    scheduledAt: '2026-07-26T12:00:00.000Z',
    status: 'completed',
    attempt: 1,
    ...overrides
  };
}

const v1 = (series: TaskSeries[], runs: TaskRun[] = []): unknown => ({
  schemaVersion: 1,
  series,
  runs
});

describe('migrate — forward compatibility', () => {
  it('should_migrate_v1_state_forward_without_data_loss', () => {
    const state = v1([v1Series(), v1Series({ id: 'series-2' })], [v1Run()]);

    const result = migrate(state) as SynchronyState;

    assert.equal(result.schemaVersion, SCHEMA_VERSION);
    assert.equal(result.series.length, 2);
    assert.equal(result.runs.length, 1);
  });

  it('should_accept_state_already_at_the_current_version', () => {
    const current = { schemaVersion: SCHEMA_VERSION, series: [v1Series()], runs: [] };

    const result = migrate(current) as SynchronyState;

    assert.equal(result.schemaVersion, SCHEMA_VERSION);
    assert.equal(result.series.length, 1);
  });

  it('should_not_mutate_the_state_it_was_given', () => {
    const state = v1([v1Series({ enabled: false })], [v1Run()]);

    migrate(state);

    assert.equal((state as SynchronyState).schemaVersion, 1);
    assert.equal((state as SynchronyState).series[0].enabled, false);
  });
});

describe('migrate — the v1 enabled/spent split', () => {
  it('should_reread_a_retired_one_shot_as_spent_rather_than_paused', () => {
    // v1 overloaded `enabled: false` for both meanings. A disabled one-shot
    // with a run on record was retired by the scheduler, not paused by a user.
    const state = v1([v1Series({ enabled: false })], [v1Run()]);

    const result = migrate(state) as SynchronyState;

    assert.equal(result.series[0].spent, true);
    assert.equal(result.series[0].enabled, true);
  });

  it('should_leave_a_genuinely_paused_one_shot_paused', () => {
    // No runs on record means the user paused it before it ever fired.
    const state = v1([v1Series({ enabled: false })], []);

    const result = migrate(state) as SynchronyState;

    assert.equal(result.series[0].enabled, false);
    assert.equal(result.series[0].spent, undefined);
  });

  it('should_leave_a_paused_recurring_series_alone', () => {
    // A recurring series is never retired, so disabled can only mean paused.
    const recurring = v1Series({
      enabled: false,
      recurrence: { daysOfWeek: [1, 2, 3, 4, 5], timeLocal: '09:00' }
    });

    const result = migrate(v1([recurring], [v1Run()])) as SynchronyState;

    assert.equal(result.series[0].enabled, false);
    assert.equal(result.series[0].spent, undefined);
  });

  it('should_leave_an_active_one_shot_untouched', () => {
    const result = migrate(v1([v1Series()], [])) as SynchronyState;

    assert.equal(result.series[0].enabled, true);
    assert.equal(result.series[0].spent, undefined);
  });
});

describe('migrate — refusals', () => {
  it('should_back_up_rather_than_discard_genuinely_foreign_state', () => {
    assert.equal(migrate({ hello: 'world' }), undefined);
    assert.equal(migrate('a string'), undefined);
    assert.equal(migrate(null), undefined);
    assert.equal(migrate(undefined), undefined);
  });

  it('should_refuse_state_missing_its_collections', () => {
    assert.equal(migrate({ schemaVersion: 1, series: [] }), undefined);
    assert.equal(migrate({ schemaVersion: 1, runs: [] }), undefined);
  });

  it('should_refuse_state_written_by_a_newer_synchrony', () => {
    // Guessing at a future shape risks corrupting it on the next write.
    const future = { schemaVersion: SCHEMA_VERSION + 1, series: [], runs: [] };

    assert.equal(migrate(future), undefined);
  });

  it('should_refuse_a_nonsense_version_number', () => {
    assert.equal(migrate({ schemaVersion: 0, series: [], runs: [] }), undefined);
    assert.equal(migrate({ schemaVersion: '1', series: [], runs: [] }), undefined);
  });
});

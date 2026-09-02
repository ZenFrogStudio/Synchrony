import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextTopOfHour, retryPlan } from '../src/retry';
import { TaskRun, TaskSeries } from '../src/types';

/**
 * What happens after a run fails, tested without a clock, a store or an editor.
 *
 * The case this exists for cannot be reproduced by hand: a plan fails at 2am
 * because the credits ran out, and the question is whether the four plans behind
 * it in the chain still run, or whether the whole night is lost.
 */

const NOW = Date.parse('2026-07-26T12:20:00.000Z');
const MINUTE = 60_000;

function series(overrides: Partial<TaskSeries> = {}): TaskSeries {
  return {
    id: 'head',
    filePath: 'D:\\plans\\audit.md',
    fileName: 'audit.md',
    cwd: 'D:\\repo',
    permissionMode: 'auto',
    recurrence: null,
    nextRunAt: new Date(NOW).toISOString(),
    enabled: true,
    maxRetries: 3,
    createdAt: new Date(NOW).toISOString(),
    ...overrides
  };
}

const follower = (overrides: Partial<TaskSeries> = {}) =>
  series({
    id: 'next',
    fileName: 'review.md',
    spent: true,
    chain: { after: 'head', delayMinutes: 15, stopOnFailure: true },
    ...overrides
  });

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run-1',
    seriesId: 'head',
    scheduledAt: new Date(NOW - 60 * MINUTE).toISOString(),
    status: 'failed',
    attempt: 1,
    ...overrides
  };
}

/** The failing run's own series first, then whatever else is in the schedule. */
function plan(failing: TaskSeries, rest: TaskSeries[], overrides: Partial<TaskRun> = {}) {
  return retryPlan({
    run: run({ seriesId: failing.id, ...overrides }),
    series: failing,
    allSeries: [failing, ...rest],
    retryable: true,
    nowMs: NOW,
    delayMinutes: 60
  });
}

describe('retry — the top of the hour', () => {
  it('should_return_the_next_whole_hour', () => {
    assert.equal(nextTopOfHour(Date.parse('2026-07-26T12:20:00.000Z')), '2026-07-26T13:00:00.000Z');
  });

  it('should_return_an_hour_later_when_already_exactly_on_the_hour', () => {
    // The same instant would fire on this very tick, straight back into the
    // outage the retry is meant to be waiting out.
    assert.equal(nextTopOfHour(Date.parse('2026-07-26T12:00:00.000Z')), '2026-07-26T13:00:00.000Z');
  });

  it('should_roll_over_the_day_at_the_last_hour', () => {
    assert.equal(nextTopOfHour(Date.parse('2026-07-26T23:41:00.000Z')), '2026-07-27T00:00:00.000Z');
  });
});

describe('retry — an ordinary plan', () => {
  it('should_retry_at_the_configured_delay_while_attempts_remain', () => {
    const result = plan(series(), []);

    assert.equal(result.kind, 'retry');
    assert.equal(result.kind === 'retry' && result.attempt, 2);
    assert.equal(
      result.kind === 'retry' && Date.parse(result.scheduledAt),
      NOW + 60 * MINUTE
    );
  });

  it('should_stop_after_maxRetries_rather_than_retrying_forever', () => {
    // Nothing is waiting on this plan, so an endless retry would only be an
    // endless failure nobody asked to keep watching.
    const result = plan(series(), [], { attempt: 4 });

    assert.equal(result.kind, 'report');
  });
});

describe('retry — a plan inside a chain', () => {
  it('should_use_the_ordinary_bounded_retries_first', () => {
    const result = plan(series(), [follower()]);

    assert.equal(result.kind, 'retry');
  });

  it('should_keep_the_head_retrying_hourly_once_its_attempts_are_gone', () => {
    // The head carries no `chain` of its own — it is only in a chain because
    // something else is waiting on it.
    const result = plan(series(), [follower()], { attempt: 4 });

    assert.equal(result.kind, 'recovery');
    assert.equal(result.kind === 'recovery' && result.scheduledAt, '2026-07-26T13:00:00.000Z');
    assert.equal(result.kind === 'recovery' && result.attempt, 5);
  });

  it('should_keep_a_follower_retrying_hourly_too', () => {
    const result = plan(follower(), [series()], { attempt: 4 });

    assert.equal(result.kind, 'recovery');
  });

  it('should_give_up_on_a_failure_that_retrying_cannot_help', () => {
    // Rejected credentials, a missing plan file, a cancelled run: these fail
    // identically forever, and an hourly retry only delays the discovery.
    const result = retryPlan({
      run: run({ attempt: 4 }),
      series: series(),
      allSeries: [series(), follower()],
      retryable: false,
      nowMs: NOW,
      delayMinutes: 60
    });

    assert.equal(result.kind, 'report');
  });

  it('should_leave_a_plan_that_merely_looks_chained_alone', () => {
    // Another chain in the same folder is not this plan's business.
    const elsewhere = series({ id: 'other' });
    const linked = follower({ id: 'other-next', chain: { after: 'other', delayMinutes: 5, stopOnFailure: true } });

    const result = plan(series(), [elsewhere, linked], { attempt: 4 });

    assert.equal(result.kind, 'report');
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { skipPastOccurrence, stampRepeatEnd } from '../src/series';
import { DAILY, TaskSeries } from '../src/types';

/**
 * The stamp that dates a plan's move from repeating to one-shot. `retire.ts`
 * reads nothing else to tell a run made under an old repeat rule from a run the
 * plan made on its own, so every rule here is one the archive sweep depends on.
 */

const WHEN = '2026-03-01T12:00:00.000Z';

function series(overrides: Partial<TaskSeries> = {}): TaskSeries {
  return {
    id: 'a',
    filePath: 'D:\\plans\\nightly.md',
    fileName: 'nightly.md',
    cwd: 'D:\\project',
    permissionMode: 'auto',
    recurrence: null,
    nextRunAt: '2026-03-02T09:00:00.000Z',
    enabled: true,
    maxRetries: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

describe('series — dating the end of a repeat rule', () => {
  it('should_stamp_the_time_a_repeat_rule_is_removed', () => {
    const repeating = series({ recurrence: { daysOfWeek: DAILY, timeLocal: '09:00' } });

    const patch = stampRepeatEnd(repeating, { recurrence: null }, WHEN);

    assert.deepEqual(patch, { recurrence: null, repeatEndedAt: WHEN });
  });

  it('should_not_stamp_a_series_that_was_already_a_one_shot', () => {
    // Nothing changed, so nothing is dated — and a plan that never repeated
    // must keep archiving on its first completed run, as it always has.
    const patch = stampRepeatEnd(series(), { recurrence: null }, WHEN);

    assert.deepEqual(patch, { recurrence: null });
  });

  it('should_clear_the_stamp_when_a_repeat_rule_is_set_again', () => {
    // A series that repeats again has no end. The key is written as `undefined`
    // so `JSON.stringify` drops it from `state.json` rather than leaving a
    // stale date behind for the next time the rule comes off.
    const stopped = series({ repeatEndedAt: WHEN });
    const rule = { daysOfWeek: DAILY, timeLocal: '09:00' };

    const patch = stampRepeatEnd(stopped, { recurrence: rule }, '2026-03-05T12:00:00.000Z');

    assert.deepEqual(patch, { recurrence: rule, repeatEndedAt: undefined });
    assert.ok('repeatEndedAt' in patch, 'the key must be present so Object.assign clears it');
  });

  it('should_leave_a_patch_that_says_nothing_about_repeating_alone', () => {
    const repeating = series({ recurrence: { daysOfWeek: DAILY, timeLocal: '09:00' } });

    const patch = stampRepeatEnd(repeating, { enabled: false, spent: true }, WHEN);

    assert.deepEqual(patch, { enabled: false, spent: true });
  });
});

describe('series — a repeating plan given a time already gone', () => {
  const NOW = Date.parse(WHEN);
  const PAST = '2026-03-01T08:00:00.000Z';
  const rule = { daysOfWeek: DAILY, timeLocal: '09:00' };

  it('should_move_a_past_time_on_to_the_next_occurrence', () => {
    // The bug this closes: the scheduler read the past instant as a missed run.
    const patch = skipPastOccurrence(series({ recurrence: rule, nextRunAt: PAST }), NOW);

    assert.ok(patch.nextRunAt, 'a past time must be replaced');
    assert.ok(Date.parse(patch.nextRunAt) > NOW, 'the replacement must be in the future');
  });

  it('should_leave_a_future_time_alone', () => {
    assert.deepEqual(skipPastOccurrence(series({ recurrence: rule }), NOW), {});
  });

  it('should_leave_one_shots_paused_and_spent_plans_alone', () => {
    // None of these fires, so a past time on them cannot turn into a missed run.
    assert.deepEqual(skipPastOccurrence(series({ nextRunAt: PAST }), NOW), {});
    assert.deepEqual(
      skipPastOccurrence(series({ recurrence: rule, nextRunAt: PAST, enabled: false }), NOW),
      {}
    );
    assert.deepEqual(
      skipPastOccurrence(series({ recurrence: rule, nextRunAt: PAST, spent: true }), NOW),
      {}
    );
  });
});

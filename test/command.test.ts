import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CommandInput, CommandVerdict, RemoteCommand, validateCommand } from '../src/command';
import { COMMAND_TTL_MS, TaskRun, TaskSeries } from '../src/types';

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const HOUR = 60 * 60_000;

function series(overrides: Partial<TaskSeries> = {}): TaskSeries {
  return {
    id: 's1',
    filePath: 'D:\\repo\\plans\\nightly.md',
    fileName: 'nightly.md',
    cwd: 'D:\\repo',
    permissionMode: 'acceptEdits',
    recurrence: null,
    nextRunAt: new Date(NOW + HOUR).toISOString(),
    enabled: true,
    maxRetries: 3,
    createdAt: '2026-07-01T09:00:00.000Z',
    ...overrides
  };
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'r1',
    seriesId: 's1',
    scheduledAt: new Date(NOW).toISOString(),
    status: 'missed',
    attempt: 1,
    ...overrides
  };
}

function check(
  command: Partial<RemoteCommand> = {},
  overrides: Partial<CommandInput> = {}
): CommandVerdict {
  return validateCommand({
    command: {
      id: 'c1',
      kind: 'runNow',
      seriesId: 's1',
      createdAt: new Date(NOW).toISOString(),
      ...command
    },
    series: [series()],
    runs: [run()],
    now: NOW,
    ttlMs: COMMAND_TTL_MS,
    ...overrides
  });
}

/** The patch of an accepted series command, or fails the test. */
function patchOf(verdict: CommandVerdict): Partial<TaskSeries> {
  assert.ok(verdict.ok && verdict.kind === 'series', `expected a series patch, got ${JSON.stringify(verdict)}`);
  return verdict.patch;
}

describe('validateCommand — the allowlist', () => {
  it('should_refuse_a_command_that_is_not_on_the_list', () => {
    const verdict = check({ kind: 'deleteSeries' });

    assert.equal(verdict.ok, false);
  });

  it('should_refuse_to_change_the_permission_mode_even_by_its_own_command', () => {
    // Raising permissions remotely is the escalation this module exists to stop.
    const verdict = check({ kind: 'setPermissionMode', payload: { permissionMode: 'bypassPermissions' } });

    assert.equal(verdict.ok, false);
  });

  it('should_refuse_to_change_the_plan_text', () => {
    const verdict = check({ kind: 'savePlan', payload: { text: 'rm -rf /' } });

    assert.equal(verdict.ok, false);
  });

  it('should_refuse_to_change_which_engine_runs_a_task', () => {
    // `agent` decides which executable gets spawned, so it is *what* a task
    // does — the same escalation as raising its permissions.
    const verdict = check({ kind: 'setAgent', payload: { agent: 'opencode' } });

    assert.equal(verdict.ok, false);
  });

  it('should_ignore_extra_fields_smuggled_into_an_allowed_command', () => {
    // An accepted command must yield only the fields its own rule builds.
    const patch = patchOf(
      check({
        kind: 'setEnabled',
        payload: {
          enabled: false,
          permissionMode: 'bypassPermissions',
          agent: 'opencode',
          cwd: 'C:\\',
          filePath: 'x'
        }
      })
    );

    assert.deepEqual(patch, { enabled: false });
  });
});

describe('validateCommand — expiry', () => {
  it('should_mark_a_command_older_than_the_ttl_stale_rather_than_applying_it', () => {
    // Commands apply synchronously, so an old one is a replayed request.
    const verdict = check({ createdAt: new Date(NOW - 7 * HOUR).toISOString() });

    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok === false && verdict.stale, true);
  });

  it('should_still_apply_a_command_inside_the_ttl', () => {
    const verdict = check({ createdAt: new Date(NOW - 5 * HOUR).toISOString() });

    assert.equal(verdict.ok, true);
  });

  it('should_refuse_a_command_dated_far_in_the_future', () => {
    // Otherwise a forged or badly-skewed timestamp never expires.
    const verdict = check({ createdAt: new Date(NOW + 3 * HOUR).toISOString() });

    assert.equal(verdict.ok, false);
    assert.notEqual(verdict.ok === false && verdict.stale, true);
  });

  it('should_tolerate_a_small_clock_difference_between_phone_and_desktop', () => {
    const verdict = check({ createdAt: new Date(NOW + 30_000).toISOString() });

    assert.equal(verdict.ok, true);
  });

  it('should_refuse_a_command_with_an_unparseable_timestamp', () => {
    assert.equal(check({ createdAt: 'yesterday' }).ok, false);
  });
});

describe('validateCommand — targeting', () => {
  it('should_refuse_a_command_for_a_series_that_no_longer_exists', () => {
    assert.equal(check({ seriesId: 'gone' }).ok, false);
  });

  it('should_accept_run_now_for_a_series_that_exists', () => {
    const verdict = check({ kind: 'runNow' });

    assert.ok(verdict.ok && verdict.kind === 'runNow');
    assert.equal(verdict.ok && verdict.kind === 'runNow' && verdict.seriesId, 's1');
  });

  it('should_refuse_to_dismiss_a_run_that_no_longer_exists', () => {
    assert.equal(check({ kind: 'dismissRun', runId: 'gone' }).ok, false);
  });

  it('should_accept_dismissing_a_run_that_is_present', () => {
    const verdict = check({ kind: 'dismissRun', runId: 'r1' });

    assert.ok(verdict.ok && verdict.kind === 'dismissRun');
  });
});

describe('validateCommand — setEnabled', () => {
  it('should_pause_a_series', () => {
    assert.deepEqual(patchOf(check({ kind: 'setEnabled', payload: { enabled: false } })), {
      enabled: false
    });
  });

  it('should_refuse_a_value_that_is_not_a_boolean', () => {
    assert.equal(check({ kind: 'setEnabled', payload: { enabled: 'yes' } }).ok, false);
  });

  it('should_not_revive_a_spent_one_shot_which_would_fire_straight_into_missed', () => {
    // Deliberately narrower than the desktop's toggle. Resuming a one-shot
    // whose time is long past would immediately be marked missed.
    const patch = patchOf(
      check(
        { kind: 'setEnabled', payload: { enabled: true } },
        { series: [series({ enabled: false, spent: true })] }
      )
    );

    assert.ok(!('spent' in patch));
  });
});

describe('validateCommand — reschedule', () => {
  it('should_move_a_one_shot_to_the_requested_time', () => {
    const target = new Date(NOW + 6 * HOUR).toISOString();

    const patch = patchOf(check({ kind: 'reschedule', payload: { nextRunAt: target } }));

    assert.equal(patch.nextRunAt, target);
  });

  it('should_put_a_fired_one_shot_back_on_the_schedule', () => {
    const patch = patchOf(
      check(
        { kind: 'reschedule', payload: { nextRunAt: new Date(NOW + HOUR).toISOString() } },
        { series: [series({ spent: true })] }
      )
    );

    assert.equal(patch.spent, false);
  });

  it('should_leave_a_paused_series_paused', () => {
    // Un-pausing something you deliberately paused is a surprise, so moving a
    // time never does it.
    const patch = patchOf(
      check(
        { kind: 'reschedule', payload: { nextRunAt: new Date(NOW + HOUR).toISOString() } },
        { series: [series({ enabled: false })] }
      )
    );

    assert.ok(!('enabled' in patch));
  });

  it('should_move_a_recurring_rule_to_match_the_new_time', () => {
    // Built in local time so the assertion holds in any timezone — and the
    // desktop's clock is the right one, since it runs the job.
    const target = new Date(2026, 7, 1, 18, 30);

    const patch = patchOf(
      check(
        { kind: 'reschedule', payload: { nextRunAt: target.toISOString() } },
        { series: [series({ recurrence: { daysOfWeek: [1, 3], timeLocal: '09:00' } })] }
      )
    );

    assert.deepEqual(patch.recurrence, { daysOfWeek: [1, 3], timeLocal: '18:30' });
  });

  it('should_move_a_monthly_rules_day_to_match_the_new_date', () => {
    // Monthly has no day picker of its own: the date you reschedule to is the
    // day it repeats on from then on.
    const target = new Date(2026, 7, 3, 18, 30);

    const patch = patchOf(
      check(
        { kind: 'reschedule', payload: { nextRunAt: target.toISOString() } },
        { series: [series({ recurrence: { daysOfWeek: [], timeLocal: '09:00', dayOfMonth: 15 } })] }
      )
    );

    assert.deepEqual(patch.recurrence, { daysOfWeek: [], timeLocal: '18:30', dayOfMonth: 3 });
  });

  it('should_refuse_a_time_that_has_clearly_already_passed', () => {
    const verdict = check({
      kind: 'reschedule',
      payload: { nextRunAt: new Date(NOW - HOUR).toISOString() }
    });

    assert.equal(verdict.ok, false);
  });

  it('should_allow_a_time_a_few_seconds_past_so_run_at_once_still_works', () => {
    const verdict = check({
      kind: 'reschedule',
      payload: { nextRunAt: new Date(NOW - 30_000).toISOString() }
    });

    assert.equal(verdict.ok, true);
  });

  it('should_refuse_a_date_it_cannot_parse', () => {
    assert.equal(check({ kind: 'reschedule', payload: { nextRunAt: 'soon' } }).ok, false);
  });

  it('should_refuse_a_reschedule_with_no_payload_at_all', () => {
    assert.equal(check({ kind: 'reschedule' }).ok, false);
  });
});

describe('validateCommand — a plan that runs as part of a chain', () => {
  it('should_refuse_to_move_a_chained_plans_time', () => {
    // It has no time of its own to move: the plan before it finishing is what
    // sets one. Accepting this would write a time the next tick overwrites.
    const chained = series({ chain: { after: 'other', delayMinutes: 15, stopOnFailure: true } });

    const verdict = check(
      { kind: 'reschedule', payload: { nextRunAt: new Date(NOW + HOUR).toISOString() } },
      { series: [chained] }
    );

    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : '', /Unlink/);
  });

  it('should_still_let_the_phone_pause_or_run_one', () => {
    const chained = series({ chain: { after: 'other', delayMinutes: 15, stopOnFailure: true } });

    assert.equal(check({ kind: 'runNow' }, { series: [chained] }).ok, true);
    assert.equal(
      check({ kind: 'setEnabled', payload: { enabled: false } }, { series: [chained] }).ok,
      true
    );
  });
});

describe('validateCommand — setRepeat', () => {
  it('should_turn_a_recurring_series_into_a_one_shot', () => {
    const patch = patchOf(check({ kind: 'setRepeat', payload: { repeat: 'once' } }));

    assert.equal(patch.recurrence, null);
  });

  it('should_build_a_daily_rule_from_the_series_own_time', () => {
    const patch = patchOf(check({ kind: 'setRepeat', payload: { repeat: 'daily' } }));

    assert.deepEqual(patch.recurrence?.daysOfWeek, [0, 1, 2, 3, 4, 5, 6]);
  });

  it('should_sort_and_deduplicate_the_days_of_a_weekly_rule', () => {
    const patch = patchOf(
      check({ kind: 'setRepeat', payload: { repeat: 'weekly', daysOfWeek: [5, 1, 5, 3] } })
    );

    assert.deepEqual(patch.recurrence?.daysOfWeek, [1, 3, 5]);
  });

  it('should_refuse_a_weekly_rule_with_no_days', () => {
    assert.equal(check({ kind: 'setRepeat', payload: { repeat: 'weekly', daysOfWeek: [] } }).ok, false);
  });

  it('should_refuse_a_day_outside_the_week', () => {
    assert.equal(check({ kind: 'setRepeat', payload: { repeat: 'weekly', daysOfWeek: [1, 9] } }).ok, false);
  });

  it('should_refuse_a_day_that_is_not_a_whole_number', () => {
    assert.equal(
      check({ kind: 'setRepeat', payload: { repeat: 'weekly', daysOfWeek: ['1'] } }).ok,
      false
    );
  });

  it('should_build_a_monthly_rule_from_the_day_the_series_already_runs_on', () => {
    const patch = patchOf(check({ kind: 'setRepeat', payload: { repeat: 'monthly' } }));

    // Read back rather than hardcoded: `nextRunAt` is a UTC instant and the day
    // of the month is the local one, which differs by zone.
    const expected = new Date(Date.parse(series().nextRunAt)).getDate();
    assert.equal(patch.recurrence?.dayOfMonth, expected);
  });

  it('should_leave_a_monthly_rules_days_of_week_empty', () => {
    const patch = patchOf(check({ kind: 'setRepeat', payload: { repeat: 'monthly' } }));

    assert.deepEqual(patch.recurrence?.daysOfWeek, []);
  });

  it('should_refuse_a_repeat_it_does_not_recognise', () => {
    const verdict = check({ kind: 'setRepeat', payload: { repeat: 'hourly' } });

    assert.equal(verdict.ok, false);
    assert.equal(
      verdict.ok === false && verdict.reason,
      'setRepeat expects once, daily, weekly or monthly.'
    );
  });
});

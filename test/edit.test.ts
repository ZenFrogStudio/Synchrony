import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { seriesEdit } from '../src/edit';
import { DAILY } from '../src/types';

/**
 * The manager's edit boundary. `Partial<TaskSeries>` is a compile-time hint that
 * disappears at runtime, so these are the rules that actually hold.
 */

describe('edit — fields that must never be settable', () => {
  it('should_refuse_to_repoint_a_series_at_another_file', () => {
    // `filePath` decides which file the agent is handed as its prompt.
    const { patch, rejected } = seriesEdit({ filePath: 'D:\\somewhere\\else.md' });

    assert.deepEqual(patch, {});
    assert.deepEqual(rejected, ['filePath']);
  });

  it('should_refuse_to_change_a_series_identity', () => {
    const { patch, rejected } = seriesEdit({ id: 'other', fileName: 'x.md', createdAt: 'then' });

    assert.deepEqual(patch, {});
    assert.deepEqual(rejected.sort(), ['createdAt', 'fileName', 'id']);
  });

  it('should_drop_a_field_smuggled_in_alongside_a_valid_one', () => {
    const { patch, rejected } = seriesEdit({ enabled: false, filePath: 'D:\\evil.md' });

    assert.deepEqual(patch, { enabled: false });
    assert.deepEqual(rejected, ['filePath']);
  });

  it('should_drop_a_field_that_is_not_part_of_a_series_at_all', () => {
    const { patch, rejected } = seriesEdit({ enabled: true, somethingElse: 1 });

    assert.deepEqual(patch, { enabled: true });
    assert.deepEqual(rejected, ['somethingElse']);
  });

  it('should_refuse_a_patch_that_tries_to_set_repeatEndedAt', () => {
    // Bookkeeping written by `stampRepeatEnd`, not a field anyone edits. A
    // webview that could set it could date a plan's move to one-shot into the
    // future and hold it in the library for good.
    const { patch, rejected } = seriesEdit({ repeatEndedAt: '2099-01-01T00:00:00.000Z' });

    assert.deepEqual(patch, {});
    assert.deepEqual(rejected, ['repeatEndedAt']);
  });

  it('should_reject_a_patch_that_is_not_an_object', () => {
    assert.deepEqual(seriesEdit('enabled=true').patch, {});
    assert.deepEqual(seriesEdit(null).patch, {});
  });
});

describe('edit — a chain link', () => {
  const link = { after: 'series-1', delayMinutes: 15, stopOnFailure: true };

  it('should_accept_a_well_formed_link', () => {
    assert.deepEqual(seriesEdit({ chain: link }).patch, { chain: link });
  });

  it('should_treat_null_as_taking_the_plan_off_the_chain', () => {
    // Unlink. A rejection here would leave the plan on a chain it was told to
    // leave, which is worse than a field quietly ignored.
    const { patch, rejected } = seriesEdit({ chain: null });

    assert.deepEqual(patch, { chain: undefined });
    assert.deepEqual(rejected, []);
  });

  it('should_accept_a_gap_of_nothing_at_all', () => {
    const straightAway = { ...link, delayMinutes: 0 };

    assert.deepEqual(seriesEdit({ chain: straightAway }).patch, { chain: straightAway });
  });

  it('should_refuse_a_gap_longer_than_a_day', () => {
    // Past that it is a clock time, not a chain.
    assert.deepEqual(seriesEdit({ chain: { ...link, delayMinutes: 1441 } }).rejected, ['chain']);
  });

  it('should_refuse_a_gap_that_is_not_a_whole_number_of_minutes', () => {
    assert.deepEqual(seriesEdit({ chain: { ...link, delayMinutes: -1 } }).rejected, ['chain']);
    assert.deepEqual(seriesEdit({ chain: { ...link, delayMinutes: 1.5 } }).rejected, ['chain']);
    assert.deepEqual(seriesEdit({ chain: { ...link, delayMinutes: '15' } }).rejected, ['chain']);
  });

  it('should_refuse_a_link_that_names_no_plan', () => {
    assert.deepEqual(seriesEdit({ chain: { ...link, after: '' } }).rejected, ['chain']);
    assert.deepEqual(seriesEdit({ chain: { delayMinutes: 15, stopOnFailure: true } }).rejected, ['chain']);
  });

  it('should_refuse_a_link_that_does_not_say_what_a_failure_means', () => {
    // The arming rule reads it on every tick; an absent flag would read as
    // "carry on", which is the more surprising of the two answers.
    assert.deepEqual(seriesEdit({ chain: { after: 'series-1', delayMinutes: 15 } }).rejected, ['chain']);
  });

  it('should_keep_nothing_but_the_three_fields_a_link_has', () => {
    const { patch } = seriesEdit({ chain: { ...link, armed: true } });

    assert.deepEqual(patch, { chain: link });
  });
});

describe('edit — the model argument', () => {
  it('should_accept_a_pinned_model_id', () => {
    assert.deepEqual(seriesEdit({ model: 'claude-opus-5' }).patch, { model: 'claude-opus-5' });
  });

  it('should_accept_a_bare_family_alias', () => {
    assert.deepEqual(seriesEdit({ model: 'sonnet' }).patch, { model: 'sonnet' });
  });

  it('should_read_an_empty_model_as_the_account_default', () => {
    const { patch, rejected } = seriesEdit({ model: '' });

    assert.deepEqual(patch, { model: undefined });
    assert.deepEqual(rejected, []);
  });

  it('should_reject_a_model_carrying_shell_syntax', () => {
    // The reason this check exists: `runner.ts` spawns through a shell on
    // Windows, and Node does not quote arguments in shell mode.
    for (const hostile of ['sonnet & calc', 'sonnet | more', 'sonnet;whoami', '"sonnet"', '$(id)']) {
      const { patch, rejected } = seriesEdit({ model: hostile });
      assert.deepEqual(patch, {}, `should have rejected ${hostile}`);
      assert.deepEqual(rejected, ['model']);
    }
  });

  it('should_accept_a_provider_qualified_model_id', () => {
    // Every opencode model id needs a slash, and a local one needs a colon too.
    assert.deepEqual(seriesEdit({ model: 'opencode/north-mini-code-free' }).patch, {
      model: 'opencode/north-mini-code-free'
    });
    assert.deepEqual(seriesEdit({ model: 'ollama/gemma4:26b' }).patch, {
      model: 'ollama/gemma4:26b'
    });
  });

  it('should_reject_a_model_long_enough_to_be_a_payload', () => {
    assert.deepEqual(seriesEdit({ model: 'a'.repeat(200) }).rejected, ['model']);
  });
});

describe('edit — the engine', () => {
  it('should_accept_an_engine_this_build_knows_about', () => {
    assert.deepEqual(seriesEdit({ agent: 'opencode' }).patch, { agent: 'opencode' });
    assert.deepEqual(seriesEdit({ agent: 'claude' }).patch, { agent: 'claude' });
  });

  it('should_read_an_empty_engine_as_claude', () => {
    const { patch, rejected } = seriesEdit({ agent: '' });

    assert.deepEqual(patch, { agent: undefined });
    assert.deepEqual(rejected, []);
  });

  it('should_reject_an_engine_that_does_not_exist', () => {
    // `agent` chooses which executable gets spawned, so it is checked against a
    // closed list rather than by shape.
    for (const hostile of ['codex', 'C:\\evil.exe', 'claude; calc', 1, {}]) {
      assert.deepEqual(seriesEdit({ agent: hostile }).rejected, ['agent'], String(hostile));
    }
  });
});

describe('edit — permissions', () => {
  it('should_accept_a_real_permission_mode', () => {
    assert.deepEqual(seriesEdit({ permissionMode: 'bypassPermissions' }).patch, {
      permissionMode: 'bypassPermissions'
    });
  });

  it('should_reject_a_permission_mode_the_cli_does_not_have', () => {
    assert.deepEqual(seriesEdit({ permissionMode: 'trustMe' }).rejected, ['permissionMode']);
  });
});

describe('edit — the schedule', () => {
  it('should_normalise_a_valid_time_to_utc', () => {
    const { patch } = seriesEdit({ nextRunAt: '2026-07-26T12:00:00+02:00' });

    assert.equal(patch.nextRunAt, '2026-07-26T10:00:00.000Z');
  });

  it('should_reject_a_time_that_is_not_a_date', () => {
    assert.deepEqual(seriesEdit({ nextRunAt: 'soon' }).rejected, ['nextRunAt']);
    assert.deepEqual(seriesEdit({ nextRunAt: 12345 }).rejected, ['nextRunAt']);
  });

  it('should_accept_a_one_shot_by_clearing_the_recurrence', () => {
    const { patch, rejected } = seriesEdit({ recurrence: null });

    assert.deepEqual(patch, { recurrence: null });
    assert.deepEqual(rejected, []);
  });

  it('should_accept_a_daily_rule', () => {
    const { patch } = seriesEdit({ recurrence: { daysOfWeek: DAILY, timeLocal: '09:00' } });

    assert.deepEqual(patch.recurrence, { daysOfWeek: DAILY, timeLocal: '09:00' });
  });

  it('should_sort_and_deduplicate_the_days_of_a_weekly_rule', () => {
    const { patch } = seriesEdit({ recurrence: { daysOfWeek: [5, 1, 1, 3], timeLocal: '09:00' } });

    assert.deepEqual(patch.recurrence?.daysOfWeek, [1, 3, 5]);
  });

  it('should_reject_a_recurrence_with_no_days', () => {
    // This is the one that would stop *every* task: an empty rule makes
    // computeNextRun throw, inside the scheduler's tick.
    assert.deepEqual(seriesEdit({ recurrence: { daysOfWeek: [], timeLocal: '09:00' } }).rejected, [
      'recurrence'
    ]);
  });

  it('should_reject_a_recurrence_with_a_day_outside_the_week', () => {
    assert.deepEqual(seriesEdit({ recurrence: { daysOfWeek: [0, 9], timeLocal: '09:00' } }).rejected, [
      'recurrence'
    ]);
  });

  it('should_reject_a_recurrence_whose_time_is_not_a_wall_clock', () => {
    for (const bad of ['9:00', '25:00', '09:60', 'morning', '']) {
      assert.deepEqual(
        seriesEdit({ recurrence: { daysOfWeek: DAILY, timeLocal: bad } }).rejected,
        ['recurrence'],
        `should have rejected ${bad}`
      );
    }
  });

  it('should_accept_a_monthly_rule_with_no_days_of_week', () => {
    const { patch, rejected } = seriesEdit({
      recurrence: { daysOfWeek: [], timeLocal: '09:00', dayOfMonth: 15 }
    });

    assert.deepEqual(patch.recurrence, { daysOfWeek: [], timeLocal: '09:00', dayOfMonth: 15 });
    assert.deepEqual(rejected, []);
  });

  it('should_reject_a_day_of_the_month_outside_1_to_31', () => {
    for (const bad of [0, 32, -1]) {
      assert.deepEqual(
        seriesEdit({ recurrence: { daysOfWeek: [], timeLocal: '09:00', dayOfMonth: bad } }).rejected,
        ['recurrence'],
        `should have rejected ${bad}`
      );
    }
  });

  it('should_reject_a_day_of_the_month_that_is_not_a_whole_number', () => {
    for (const bad of [15.5, '15', null]) {
      assert.deepEqual(
        seriesEdit({ recurrence: { daysOfWeek: [], timeLocal: '09:00', dayOfMonth: bad } }).rejected,
        ['recurrence'],
        `should have rejected ${JSON.stringify(bad)}`
      );
    }
  });

  it('should_reject_a_monthly_rule_whose_time_is_not_a_wall_clock', () => {
    // `timeLocal` is checked before the monthly branch, so a valid day cannot
    // smuggle an unusable time past the door.
    assert.deepEqual(
      seriesEdit({ recurrence: { daysOfWeek: [], timeLocal: '25:00', dayOfMonth: 15 } }).rejected,
      ['recurrence']
    );
  });
});

describe('edit — retries and working directory', () => {
  it('should_accept_a_retry_count_within_the_configured_ceiling', () => {
    assert.deepEqual(seriesEdit({ maxRetries: 0 }).patch, { maxRetries: 0 });
    assert.deepEqual(seriesEdit({ maxRetries: 10 }).patch, { maxRetries: 10 });
  });

  it('should_reject_a_retry_count_that_is_negative_fractional_or_absurd', () => {
    for (const bad of [-1, 1.5, 11, '3']) {
      assert.deepEqual(seriesEdit({ maxRetries: bad }).rejected, ['maxRetries'], `${bad}`);
    }
  });

  it('should_reject_an_empty_working_directory', () => {
    assert.deepEqual(seriesEdit({ cwd: '   ' }).rejected, ['cwd']);
  });
});

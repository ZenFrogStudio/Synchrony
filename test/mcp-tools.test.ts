import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
  PERMISSION_REFUSAL,
  planAnswers,
  planCwd,
  planQuestion,
  planSeriesOverrides,
  planSeriesUpdate,
  planTiming,
  ScheduleWhen,
  schedulerIsLive,
  Timing,
  Verdict
} from '../src/mcp-tools';
import { QuestionFile } from '../src/questions';
import { LOCK_STALE_MS, TaskSeries } from '../src/types';

/**
 * The MCP boundary as assertions, in the style of `command.test.ts`.
 *
 * The `permissionMode` cases are the ones that matter most: they are the whole
 * of what stops a connected agent granting itself unattended, recurring,
 * unrestricted tool access on this machine. Everything else here is the ordinary
 * argument checking that keeps a malformed call out of the scheduler tick.
 */

const NOW = new Date('2026-08-13T12:00:00.000Z');
const HOUR = 60 * 60_000;

function series(overrides: Partial<TaskSeries> = {}): TaskSeries {
  return {
    id: 's1',
    filePath: 'D:\\repo\\.chronos\\plans\\nightly.md',
    fileName: 'nightly.md',
    cwd: 'D:\\repo',
    permissionMode: 'auto',
    recurrence: null,
    nextRunAt: new Date(NOW.getTime() + HOUR).toISOString(),
    enabled: true,
    maxRetries: 3,
    createdAt: '2026-08-01T09:00:00.000Z',
    ...overrides
  };
}

/** The accepted value, or fails the test with the refusal that came back. */
function valueOf<T>(verdict: Verdict<T>): T {
  assert.ok(verdict.ok, `expected acceptance, got: ${verdict.ok ? '' : verdict.reason}`);
  return verdict.value;
}

/** The refusal reason, or fails the test because the call was accepted. */
function reasonOf(verdict: Verdict<unknown>): string {
  assert.ok(!verdict.ok, 'expected a refusal, got acceptance');
  return verdict.reason;
}

const schedule = (when: ScheduleWhen): Verdict<Timing> => planTiming(when, NOW);

describe('mcp permission mode', () => {
  it('should_refuse_to_set_permission_mode_when_scheduling', () => {
    const verdict = planSeriesOverrides({ permissionMode: 'bypassPermissions' });

    assert.equal(reasonOf(verdict), PERMISSION_REFUSAL);
  });

  it('should_refuse_to_set_permission_mode_when_updating', () => {
    const verdict = planSeriesUpdate({ permissionMode: 'bypassPermissions' }, series(), NOW);

    assert.equal(reasonOf(verdict), PERMISSION_REFUSAL);
  });

  it('should_refuse_even_the_mode_a_new_task_already_has', () => {
    // Not a value check — the field itself is off limits. Accepting `auto`
    // would make this a list of allowed modes, which is one edit away from
    // being the wrong list.
    assert.equal(reasonOf(planSeriesOverrides({ permissionMode: 'auto' })), PERMISSION_REFUSAL);
  });

  it('should_refuse_it_alongside_fields_that_are_perfectly_valid', () => {
    // The whole call fails rather than the one field being dropped: an agent
    // that got a partial success would report the whole thing as done.
    const verdict = planSeriesUpdate(
      { enabled: false, permissionMode: 'bypassPermissions' },
      series(),
      NOW
    );

    assert.equal(reasonOf(verdict), PERMISSION_REFUSAL);
  });
});

describe('mcp working directory', () => {
  /**
   * The companion to the `permissionMode` block above, and refused for the same
   * reason. A run starts in `auto` mode with nobody watching, so the folder it
   * starts in is the whole of what it can reach — an agent that could name any
   * folder would have talked its way to the grant `permissionMode` denies it.
   *
   * POSIX paths throughout: `path.resolve` is platform-specific, and these have
   * to assert the same thing on the machine that runs CI as on Windows.
   */
  const ROOT = path.resolve('/repo');

  it('should_keep_the_project_folder_itself', () => {
    // The default every series is born with. Refusing it would refuse the
    // ordinary case in the name of the exceptional one.
    assert.equal(valueOf(planCwd(ROOT, ROOT)), ROOT);
  });

  it('should_keep_a_folder_inside_the_project', () => {
    // A package in a monorepo is the real reason to want this argument at all.
    const inside = path.join(ROOT, 'packages', 'api');

    assert.equal(valueOf(planCwd(inside, ROOT)), inside);
  });

  it('should_resolve_a_relative_path_against_the_project_folder', () => {
    // `runner.ts` spawns with whatever is stored, so the stored value has to be
    // absolute however the agent chose to spell it.
    assert.equal(valueOf(planCwd('packages/api', ROOT)), path.join(ROOT, 'packages', 'api'));
  });

  it('should_refuse_a_folder_outside_the_project', () => {
    assert.match(reasonOf(planCwd(path.resolve('/somewhere-else'), ROOT)), /must be inside/);
  });

  it('should_refuse_a_traversal_that_climbs_out', () => {
    // The spelling that looks contained and is not — and the one an argument
    // check that only rejected absolute paths would wave straight through.
    assert.match(reasonOf(planCwd('../../etc', ROOT)), /must be inside/);
  });

  it('should_refuse_a_sibling_that_merely_starts_with_the_same_letters', () => {
    // `/repo-evil` is not inside `/repo`, though a `startsWith` check on the
    // string would say it is. This is why the comparison goes through
    // `path.relative` rather than through prefix matching.
    assert.match(reasonOf(planCwd(`${ROOT}-evil`, ROOT)), /must be inside/);
  });

  it('should_refuse_anything_that_is_not_a_path', () => {
    for (const bad of ['', '   ', undefined, null, 42, {}]) {
      assert.ok(!planCwd(bad, ROOT).ok, `${JSON.stringify(bad)} was accepted as a cwd`);
    }
  });
});

describe('mcp scheduler liveness', () => {
  // An explicit `now` throughout: the whole point is the gap between two
  // numbers, and reading one of them off the wall clock makes the boundary
  // cases below depend on how long the test run took to get here.
  const NOW_MS = NOW.getTime();

  it('should_treat_a_heartbeat_from_a_second_ago_as_live', () => {
    const live = schedulerIsLive({ heartbeatAt: NOW_MS - 1000 }, NOW_MS);

    assert.equal(live, true);
  });

  it('should_treat_no_lock_at_all_as_nothing_watching', () => {
    // The ordinary case: the folder has never been opened in VS Code, so an
    // agent's schedule sits on disk until somebody opens it.
    const live = schedulerIsLive(undefined, NOW_MS);

    assert.equal(live, false);
  });

  it('should_treat_a_heartbeat_older_than_the_stale_window_as_nothing_watching', () => {
    // A window that closed without releasing the lock leaves the file behind.
    const live = schedulerIsLive({ heartbeatAt: NOW_MS - LOCK_STALE_MS - 1 }, NOW_MS);

    assert.equal(live, false);
  });

  it('should_treat_a_heartbeat_exactly_at_the_stale_window_as_live', () => {
    // The same boundary `holdLock` uses, so the two never disagree about who is
    // holding the lock at the instant it lapses.
    const live = schedulerIsLive({ heartbeatAt: NOW_MS - LOCK_STALE_MS }, NOW_MS);

    assert.equal(live, true);
  });
});

describe('mcp schedule timing', () => {
  it('should_accept_a_one_off_at_a_future_instant', () => {
    const timing = valueOf(schedule({ at: '2026-08-13T14:30:00.000Z' }));

    assert.equal(timing.nextRunAt, '2026-08-13T14:30:00.000Z');
    assert.equal(timing.recurrence, null);
  });

  it('should_refuse_a_one_off_in_the_past', () => {
    const verdict = schedule({ at: '2026-08-13T09:00:00.000Z' });

    assert.match(reasonOf(verdict), /already passed/);
  });

  it('should_let_a_time_a_few_minutes_past_through_to_fire', () => {
    // Same tolerance as `command.ts`: a moment ago is a request to run now, not
    // a mistake, and the grace window downstream already handles it.
    const timing = valueOf(schedule({ at: new Date(NOW.getTime() - 60_000).toISOString() }));

    assert.equal(timing.recurrence, null);
  });

  it('should_refuse_a_one_off_with_no_time_at_all', () => {
    assert.match(reasonOf(schedule({})), /needs `at`/);
  });

  it('should_refuse_a_nonsense_repeat_rule', () => {
    assert.match(reasonOf(schedule({ at: '2026-08-14T02:00:00.000Z', repeat: 'hourly' })), /once, daily/);
  });

  it('should_turn_daily_into_all_seven_days', () => {
    const timing = valueOf(schedule({ repeat: 'daily', timeLocal: '02:00' }));

    assert.deepEqual(timing.recurrence?.daysOfWeek, [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(timing.recurrence?.timeLocal, '02:00');
  });

  it('should_turn_weekly_into_the_days_it_was_given_sorted_and_deduplicated', () => {
    const timing = valueOf(
      schedule({ repeat: 'weekly', timeLocal: '02:00', daysOfWeek: [5, 1, 3, 1] })
    );

    assert.deepEqual(timing.recurrence?.daysOfWeek, [1, 3, 5]);
  });

  it('should_refuse_a_weekly_rule_with_no_days', () => {
    assert.match(reasonOf(schedule({ repeat: 'weekly', timeLocal: '02:00' })), /daysOfWeek/);
  });

  it('should_refuse_a_weekly_rule_naming_a_day_that_does_not_exist', () => {
    const verdict = schedule({ repeat: 'weekly', timeLocal: '02:00', daysOfWeek: [1, 9] });

    assert.match(reasonOf(verdict), /daysOfWeek/);
  });

  it('should_turn_monthly_into_a_day_of_month_rule_with_no_weekdays', () => {
    const timing = valueOf(schedule({ repeat: 'monthly', timeLocal: '02:00', dayOfMonth: 15 }));

    assert.equal(timing.recurrence?.dayOfMonth, 15);
    assert.deepEqual(timing.recurrence?.daysOfWeek, []);
  });

  it('should_refuse_a_day_of_month_outside_the_calendar', () => {
    const verdict = schedule({ repeat: 'monthly', timeLocal: '02:00', dayOfMonth: 32 });

    assert.match(reasonOf(verdict), /dayOfMonth/);
  });

  it('should_refuse_a_repeating_rule_with_no_time_to_run_at', () => {
    assert.match(reasonOf(schedule({ repeat: 'daily' })), /timeLocal/);
  });

  it('should_refuse_a_time_that_is_not_a_wall_clock', () => {
    assert.match(reasonOf(schedule({ repeat: 'daily', timeLocal: '25:00' })), /timeLocal/);
  });

  it('should_derive_the_first_run_from_the_rule_rather_than_from_at', () => {
    // A first occurrence at a different minute from every one after it is the
    // bug this prevents: the rule is the source of truth, `at` only seeds it.
    const timing = valueOf(schedule({ repeat: 'daily', timeLocal: '02:00' }));
    const first = new Date(timing.nextRunAt);

    assert.equal(first.getHours(), 2);
    assert.equal(first.getMinutes(), 0);
    assert.ok(first.getTime() > NOW.getTime(), 'the first run must be in the future');
  });

  it('should_allow_a_repeating_rule_to_take_its_clock_from_a_past_at', () => {
    // Only the wall clock of `at` is read for a repeating rule, so a date in
    // the past is a legitimate "every day at this time, starting from then".
    const timing = valueOf(schedule({ repeat: 'daily', at: '2026-08-01T02:30:00.000Z' }));

    assert.ok(timing.recurrence, 'expected a recurrence');
    assert.ok(Date.parse(timing.nextRunAt) > NOW.getTime(), 'the first run must be in the future');
  });
});

describe('mcp schedule overrides', () => {
  it('should_pass_a_valid_patch_through_series_edit_intact', () => {
    const patch = valueOf(
      planSeriesOverrides({ agent: 'codex', model: 'gpt-5.3-codex', maxRetries: 0 })
    );

    assert.deepEqual(patch, { agent: 'codex', model: 'gpt-5.3-codex', maxRetries: 0 });
  });

  it('should_refuse_an_engine_this_build_does_not_know_about', () => {
    assert.match(reasonOf(planSeriesOverrides({ agent: 'rm -rf' })), /agent/);
  });

  it('should_refuse_a_model_id_a_shell_would_read_as_syntax', () => {
    // `runner.ts` spawns through a shell on Windows, where Node does not quote
    // arguments — so this is the same guarantee `edit.ts` makes for the manager.
    assert.match(reasonOf(planSeriesOverrides({ model: 'opus && calc.exe' })), /model/);
  });

  it('should_refuse_the_fields_that_decide_which_file_runs', () => {
    const verdict = planSeriesOverrides({ filePath: 'D:\\somewhere\\else.md' });

    assert.match(reasonOf(verdict), /filePath/);
  });

  it('should_refuse_a_field_it_has_never_heard_of', () => {
    assert.match(reasonOf(planSeriesOverrides({ sudo: true })), /sudo/);
  });

  it('should_accept_an_empty_override_set', () => {
    assert.deepEqual(valueOf(planSeriesOverrides({})), {});
  });
});

describe('mcp asking a question', () => {
  const one = [{ question: 'Should it repeat by the hour as well?' }];

  it('should_accept_a_summary_and_a_question', () => {
    const planned = valueOf(planQuestion({ summary: 'Two things first.', questions: one }));

    assert.equal(planned.summary, 'Two things first.');
    assert.deepEqual(planned.questions, [
      { id: 'q1', question: 'Should it repeat by the hour as well?' }
    ]);
  });

  it('should_number_the_questions_itself_rather_than_trusting_the_caller', () => {
    // Two questions sharing an id, or one that collides with nothing, turns
    // answering into guesswork at the far end — where there is a phone and no
    // way to go back and look.
    const planned = valueOf(
      planQuestion({
        summary: 'A few things.',
        questions: [{ question: 'One?', id: 'q9' }, { question: 'Two?', id: 'q9' }]
      })
    );

    assert.deepEqual(planned.questions.map((q) => q.id), ['q1', 'q2']);
  });

  it('should_trim_the_summary_and_the_questions', () => {
    const planned = valueOf(
      planQuestion({ summary: '  Two things.  ', questions: [{ question: '  Which one?  ' }] })
    );

    assert.equal(planned.summary, 'Two things.');
    assert.equal(planned.questions[0].question, 'Which one?');
  });

  it('should_refuse_an_empty_question_list', () => {
    // A call with nothing in it would post a question the user can look at and
    // not answer, and the session would wait on it forever.
    assert.match(reasonOf(planQuestion({ summary: 'Hello', questions: [] })), /at least one/);
  });

  it('should_refuse_a_missing_question_list', () => {
    assert.match(reasonOf(planQuestion({ summary: 'Hello' })), /at least one/);
  });

  it('should_refuse_eleven_questions', () => {
    const questions = Array.from({ length: 11 }, (_, n) => ({ question: `Question ${n}?` }));

    assert.match(reasonOf(planQuestion({ summary: 'Lots', questions })), /at most 10/);
  });

  it('should_accept_ten_questions', () => {
    const questions = Array.from({ length: 10 }, (_, n) => ({ question: `Question ${n}?` }));

    assert.equal(valueOf(planQuestion({ summary: 'Lots', questions })).questions.length, 10);
  });

  it('should_refuse_a_summary_that_is_missing_or_blank', () => {
    for (const summary of [undefined, '', '   ', 42]) {
      assert.match(reasonOf(planQuestion({ summary, questions: one })), /summary/);
    }
  });

  it('should_refuse_an_over_long_summary', () => {
    const verdict = planQuestion({ summary: 'x'.repeat(2001), questions: one });

    assert.match(reasonOf(verdict), /2000 characters/);
  });

  it('should_refuse_an_over_long_question', () => {
    const verdict = planQuestion({
      summary: 'Fine',
      questions: [{ question: 'y'.repeat(1001) }]
    });

    assert.match(reasonOf(verdict), /1000 characters/);
  });

  it('should_refuse_a_question_with_no_text', () => {
    assert.match(reasonOf(planQuestion({ summary: 'Fine', questions: [{}] })), /Question 1/);
  });

  it('should_name_which_question_was_the_problem', () => {
    const verdict = planQuestion({
      summary: 'Fine',
      questions: [{ question: 'One?' }, { question: 'Two?' }, { question: '  ' }]
    });

    assert.match(reasonOf(verdict), /Question 3/);
  });

  it('should_carry_options_through', () => {
    const planned = valueOf(
      planQuestion({
        summary: 'Fine',
        questions: [{ question: 'Which engine?', options: ['claude', 'opencode'] }]
      })
    );

    assert.deepEqual(planned.questions[0].options, ['claude', 'opencode']);
  });

  it('should_leave_options_off_a_free_text_question', () => {
    // An empty list and an absent one mean the same thing, and neither should
    // reach the answering agent as an empty shortlist.
    for (const options of [undefined, []]) {
      const planned = valueOf(
        planQuestion({ summary: 'Fine', questions: [{ question: 'What name?', options }] })
      );

      assert.equal('options' in planned.questions[0], false, JSON.stringify(options));
    }
  });

  it('should_refuse_more_than_six_options', () => {
    const options = Array.from({ length: 7 }, (_, n) => `option ${n}`);
    const verdict = planQuestion({ summary: 'Fine', questions: [{ question: 'Which?', options }] });

    assert.match(reasonOf(verdict), /at most 6 options/);
  });

  it('should_refuse_an_over_long_or_empty_option', () => {
    for (const option of ['z'.repeat(201), '']) {
      const verdict = planQuestion({
        summary: 'Fine',
        questions: [{ question: 'Which?', options: [option] }]
      });

      assert.match(reasonOf(verdict), /Question 1/);
    }
  });

  it('should_refuse_something_that_is_not_a_question_at_all', () => {
    for (const raw of [undefined, null, 'hello', 7]) {
      assert.ok(!planQuestion(raw).ok, JSON.stringify(raw));
    }
  });
});

describe('mcp answering a question', () => {
  const file = (): QuestionFile => ({
    id: 'abcdef012345',
    askedAt: '2026-08-13T09:00:00.000Z',
    summary: 'Two things first.',
    questions: [
      { id: 'q1', question: 'Hourly too?' },
      { id: 'q2', question: 'Which engine?', options: ['claude', 'opencode'] }
    ]
  });

  const both = [
    { id: 'q1', answer: 'Yes' },
    { id: 'q2', answer: 'claude' }
  ];

  it('should_accept_an_answer_to_every_question', () => {
    assert.deepEqual(valueOf(planAnswers(file(), both)), both);
  });

  it('should_return_the_answers_in_the_order_they_were_asked', () => {
    // So the session reads them alongside its own questions rather than in
    // whatever order the answering agent happened to use.
    const answers = valueOf(planAnswers(file(), [both[1], both[0]]));

    assert.deepEqual(answers.map((a) => a.id), ['q1', 'q2']);
  });

  it('should_refuse_an_answer_to_a_question_that_was_never_asked', () => {
    const verdict = planAnswers(file(), [...both, { id: 'q7', answer: 'Sure' }]);

    assert.match(reasonOf(verdict), /q7/);
  });

  it('should_list_the_questions_that_were_asked_when_it_refuses_an_unknown_id', () => {
    // The caller is another agent, and this is the only thing it has to go on.
    const verdict = planAnswers(file(), [{ id: 'q7', answer: 'Sure' }]);

    assert.match(reasonOf(verdict), /q1, q2/);
  });

  it('should_refuse_a_partial_answer_and_name_what_is_missing', () => {
    // A question can only be answered once, so recording half would strand the
    // waiting session on the half it still needs, with no way to ask again.
    const verdict = planAnswers(file(), [both[0]]);

    assert.match(reasonOf(verdict), /Still unanswered: q2/);
  });

  it('should_refuse_the_same_question_answered_twice_in_one_call', () => {
    const verdict = planAnswers(file(), [both[0], { id: 'q1', answer: 'No' }, both[1]]);

    assert.match(reasonOf(verdict), /answered twice/);
  });

  it('should_refuse_an_empty_answer', () => {
    const verdict = planAnswers(file(), [{ id: 'q1', answer: '   ' }, both[1]]);

    assert.match(reasonOf(verdict), /q1 needs an answer/);
  });

  it('should_trim_an_answer', () => {
    const answers = valueOf(planAnswers(file(), [{ id: 'q1', answer: '  Yes  ' }, both[1]]));

    assert.equal(answers[0].answer, 'Yes');
  });

  it('should_refuse_an_over_long_answer', () => {
    const verdict = planAnswers(file(), [{ id: 'q1', answer: 'x'.repeat(4001) }, both[1]]);

    assert.match(reasonOf(verdict), /4000 characters/);
  });

  it('should_refuse_an_empty_or_malformed_answer_list', () => {
    for (const raw of [[], undefined, 'yes', {}]) {
      assert.ok(!planAnswers(file(), raw).ok, JSON.stringify(raw));
    }
  });
});

describe('mcp schedule updates', () => {
  it('should_refuse_an_id_that_names_no_series', () => {
    assert.match(reasonOf(planSeriesUpdate({ enabled: false }, undefined, NOW)), /list_schedule/);
  });

  it('should_pause_a_series', () => {
    assert.deepEqual(valueOf(planSeriesUpdate({ enabled: false }, series(), NOW)), {
      enabled: false
    });
  });

  it('should_refuse_a_new_time_that_has_already_passed', () => {
    const verdict = planSeriesUpdate({ nextRunAt: '2026-08-13T09:00:00.000Z' }, series(), NOW);

    assert.match(reasonOf(verdict), /already passed/);
  });

  it('should_normalise_an_accepted_time_to_utc', () => {
    const patch = valueOf(planSeriesUpdate({ nextRunAt: '2026-08-13T14:30:00Z' }, series(), NOW));

    assert.equal(patch.nextRunAt, '2026-08-13T14:30:00.000Z');
  });

  it('should_refuse_a_call_that_changes_nothing', () => {
    // Otherwise an agent gets a success for a call that did not happen.
    assert.match(reasonOf(planSeriesUpdate({}, series(), NOW)), /Nothing to change/);
  });

  it('should_refuse_to_repoint_a_series_at_another_file', () => {
    const verdict = planSeriesUpdate({ filePath: 'D:\\repo\\evil.md' }, series(), NOW);

    assert.match(reasonOf(verdict), /filePath/);
  });

  it('should_clear_a_recurrence_when_asked_for_a_one_shot', () => {
    const patch = valueOf(
      planSeriesUpdate({ recurrence: null }, series({ recurrence: { daysOfWeek: [1], timeLocal: '02:00' } }), NOW)
    );

    assert.equal(patch.recurrence, null);
  });

  it('should_refuse_a_recurrence_the_scheduler_tick_would_throw_on', () => {
    // An empty `daysOfWeek` makes `computeNextRun` throw inside the tick, which
    // would stop every task in the folder from running — not just this one.
    const verdict = planSeriesUpdate(
      { recurrence: { daysOfWeek: [], timeLocal: '02:00' } },
      series(),
      NOW
    );

    assert.match(reasonOf(verdict), /recurrence/);
  });
});

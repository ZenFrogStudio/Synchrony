import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptySummary, foldSummary, resolveOutcome, watchdogVerdict } from '../src/outcome';
import { truncateError } from '../src/time';
import { parseLine } from '../src/transcript';
import { AgentId, ERROR_MAX_CHARS } from '../src/types';

/** A well-formed final result event, as emitted by --output-format stream-json. */
function resultEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'sess-1',
    total_cost_usd: 0.17,
    num_turns: 3,
    permission_denials: [],
    ...overrides
  });
}

const INIT_EVENT = '{"type":"system","subtype":"init","session_id":"sess-1"}';

/** `opencode run --format json`, whose payload sits one level down in `part`. */
const opencodeEvent = (type: string, part: Record<string, unknown>) =>
  JSON.stringify({ type, sessionID: 'ses_1', part });

const stepFinish = (part: Record<string, unknown> = {}) =>
  opencodeEvent('step_finish', { type: 'step-finish', reason: 'stop', ...part });

const textEvent = (text: string) => opencodeEvent('text', { type: 'text', text });

const errorEvent = (message: string, statusCode?: number) =>
  JSON.stringify({
    type: 'error',
    sessionID: 'ses_1',
    error: { name: 'UnknownError', data: { message, statusCode } }
  });

const codexThread = '{"type":"thread.started","thread_id":"thread_1"}';
const codexMessage = (text: string) =>
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } });
const codexTurnCompleted = (usage: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'turn.completed', usage });
const codexTurnFailed = (message: string, status?: number) =>
  JSON.stringify({ type: 'turn.failed', error: { message, status } });

/**
 * A stream folded exactly as `Runner.onStdout` folds it. The outcome is no
 * longer parsed out of stdout at the end, so the two modules are exercised
 * together here rather than apart — which is also how they run in production.
 */
function summarise(stdout: string, agent: AgentId = 'claude') {
  const summary = emptySummary();
  for (const line of stdout.split('\n')) {
    const parsed = parseLine(line, agent);
    if (parsed.summary) {
      foldSummary(summary, parsed.summary);
    }
  }
  return summary;
}

describe('resolveOutcome — happy path', () => {
  it('should_report_success_and_carry_session_cost_and_turns', () => {
    // Arrange
    const stdout = `${INIT_EVENT}\n${resultEvent()}`;

    // Act
    const outcome = resolveOutcome({ exitCode: 0, summary: summarise(stdout) });

    // Assert
    assert.equal(outcome.ok, true);
    assert.equal(outcome.sessionId, 'sess-1');
    assert.equal(outcome.costUsd, 0.17);
    assert.equal(outcome.numTurns, 3);
    assert.equal(outcome.denials, 0);
  });

  it('should_succeed_but_record_denials_when_tools_were_blocked', () => {
    // A run can exit 0 with tools gated. Reporting plain success would hide
    // that the plan only partly executed.
    const stdout = resultEvent({ permission_denials: [{ tool: 'Bash' }, { tool: 'Write' }] });

    const outcome = resolveOutcome({ exitCode: 0, summary: summarise(stdout) });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.denials, 2);
  });

  it('should_not_retry_a_run_that_succeeded_with_denials', () => {
    // Retrying hits the same permission gate, so it can never clear.
    const stdout = resultEvent({ permission_denials: [{ tool: 'Bash' }] });

    const outcome = resolveOutcome({ exitCode: 0, summary: summarise(stdout) });

    assert.equal(outcome.retryable, false);
  });

  it('should_report_a_codex_run_as_success_when_its_turn_completes', () => {
    const stdout = [codexThread, codexMessage('Done.'), codexTurnCompleted()].join('\n');

    const outcome = resolveOutcome({
      exitCode: 0,
      summary: summarise(stdout, 'codex'),
      engine: 'Codex'
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.sessionId, 'thread_1');
    assert.equal(outcome.numTurns, 1);
    assert.equal(outcome.resultText, 'Done.');
  });
});

describe('resolveOutcome — failure modes', () => {
  it('should_fail_and_allow_retry_when_the_exit_code_is_nonzero', () => {
    const outcome = resolveOutcome({ exitCode: 1, summary: summarise(resultEvent()) });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.retryable, true);
  });

  it('should_preserve_the_session_id_from_a_failed_run', () => {
    // Needed if the run is ever resumed rather than restarted.
    const outcome = resolveOutcome({ exitCode: 1, summary: summarise(resultEvent()) });

    assert.equal(outcome.sessionId, 'sess-1');
  });

  it('should_fail_when_the_result_event_reports_is_error', () => {
    const stdout = resultEvent({ is_error: true, result: 'rate limit exceeded' });

    const outcome = resolveOutcome({ exitCode: 0, summary: summarise(stdout) });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.error, 'rate limit exceeded');
    assert.equal(outcome.retryable, true);
  });

  it('should_fail_when_exit_is_zero_but_no_result_event_was_emitted', () => {
    // Treating this as success would mark an unfinished plan complete.
    const outcome = resolveOutcome({ exitCode: 0, summary: summarise(INIT_EVENT) });

    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? '', /No result event/);
  });

  it('should_fail_when_stdout_is_empty', () => {
    const outcome = resolveOutcome({ exitCode: 0, summary: summarise('') });

    assert.equal(outcome.ok, false);
  });

  it('should_fail_when_stdout_is_not_json_at_all', () => {
    const outcome = resolveOutcome({ exitCode: 0, summary: summarise('command not found') });

    assert.equal(outcome.ok, false);
  });

  it('should_fail_when_the_process_died_without_an_exit_code', () => {
    const outcome = resolveOutcome({ exitCode: null, summary: summarise(resultEvent()) });

    assert.equal(outcome.ok, false);
  });

  it('should_fail_when_codex_reports_a_failed_turn', () => {
    const stdout = [codexThread, codexTurnFailed('Not authenticated.', 401)].join('\n');

    const outcome = resolveOutcome({
      exitCode: 0,
      summary: summarise(stdout, 'codex'),
      engine: 'Codex'
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.authFailure, true);
    assert.equal(outcome.retryable, false);
  });
});

describe('resolveOutcome — kills', () => {
  it('should_fail_and_allow_retry_when_killed_for_idling', () => {
    const outcome = resolveOutcome({ exitCode: null, summary: summarise(''), killReason: 'idle' });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.retryable, true);
    assert.match(outcome.error ?? '', /idle/i);
  });

  it('should_fail_and_allow_retry_when_killed_for_exceeding_max_runtime', () => {
    const outcome = resolveOutcome({ exitCode: null, summary: summarise(''), killReason: 'runtime' });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.retryable, true);
  });

  it('should_not_retry_a_run_the_user_cancelled', () => {
    const outcome = resolveOutcome({ exitCode: null, summary: summarise(''), killReason: 'cancelled' });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.retryable, false);
  });

  it('should_retry_a_run_interrupted_by_shutdown', () => {
    const outcome = resolveOutcome({ exitCode: null, summary: summarise(''), killReason: 'shutdown' });

    assert.equal(outcome.retryable, true);
  });

  it('should_treat_a_kill_as_authoritative_over_a_successful_result_event', () => {
    // The process was killed after emitting a result; the kill wins.
    const outcome = resolveOutcome({
      exitCode: 0,
      summary: summarise(resultEvent()),
      killReason: 'runtime'
    });

    assert.equal(outcome.ok, false);
  });
});

describe('foldSummary — malformed streams', () => {
  it('should_ignore_a_truncated_progress_line_and_use_the_later_result', () => {
    // Stream chunks can split mid-line.
    const stdout = `{"type":"assistant","message":{"content":[{"type":"tex\n${resultEvent()}`;

    assert.equal(resolveOutcome({ exitCode: 0, summary: summarise(stdout) }).ok, true);
  });

  it('should_let_the_last_result_event_settle_the_verdict', () => {
    // Everything but cost and turns is the newest statement winning, so an
    // earlier error does not condemn a run that went on to succeed.
    const stdout = `${resultEvent({ is_error: true, result: 'stale' })}\n${resultEvent()}`;

    assert.equal(resolveOutcome({ exitCode: 0, summary: summarise(stdout) }).ok, true);
  });

  it('should_ignore_blank_and_non_object_lines', () => {
    const stdout = `\n\nnull\n[]\n${resultEvent()}\n\n`;

    assert.equal(summarise(stdout).sessionId, 'sess-1');
  });

  it('should_not_claim_a_result_was_seen_when_none_was', () => {
    assert.equal(summarise(INIT_EVENT).sawResult, false);
  });
});

describe('foldSummary — accumulating a stream', () => {
  it('should_add_up_cost_and_turns_reported_per_step', () => {
    // opencode reports both once per step rather than once per run. Claude
    // reports its cumulative totals in a single event, so the same addition
    // leaves those untouched.
    const summary = summarise(
      [
        stepFinish({ cost: 0.02 }),
        stepFinish({ cost: 0.03 }),
        stepFinish({ cost: 0.05 })
      ].join('\n'),
      'opencode'
    );

    assert.equal(summary.numTurns, 3);
    assert.ok(Math.abs((summary.costUsd ?? 0) - 0.1) < 1e-9, String(summary.costUsd));
  });

  it('should_keep_the_newest_closing_message_rather_than_the_whole_conversation', () => {
    // `resultText` is what a run card shows, and what the card wants is how the
    // run ended — not its running commentary.
    const summary = summarise(
      [textEvent('Checking the build.'), textEvent('Done — two tests fixed.')].join('\n'),
      'opencode'
    );

    assert.equal(summary.resultText, 'Done — two tests fixed.');
  });

  it('should_count_each_completed_codex_turn', () => {
    const summary = summarise(
      [codexTurnCompleted({ cost_usd: 0.02 }), codexTurnCompleted({ cost_usd: 0.03 })].join('\n'),
      'codex'
    );

    assert.equal(summary.numTurns, 2);
    assert.ok(Math.abs((summary.costUsd ?? 0) - 0.05) < 1e-9, String(summary.costUsd));
  });

  it('should_carry_the_session_id_from_any_opencode_event', () => {
    // Unlike Claude, opencode has no init event — every line repeats the id.
    assert.equal(summarise(textEvent('hello'), 'opencode').sessionId, 'ses_1');
  });
});

describe('resolveOutcome — opencode runs', () => {
  it('should_report_success_with_the_totals_summed_across_steps', () => {
    const stdout = [
      stepFinish({ cost: 0.01 }),
      textEvent('Created hello.txt and read it back.'),
      stepFinish({ cost: 0.02 })
    ].join('\n');

    const outcome = resolveOutcome({
      exitCode: 0,
      summary: summarise(stdout, 'opencode'),
      engine: 'opencode'
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.numTurns, 2);
    assert.equal(outcome.sessionId, 'ses_1');
    assert.equal(outcome.resultText, 'Created hello.txt and read it back.');
  });

  it('should_fail_and_allow_retry_when_opencode_exits_nonzero', () => {
    // opencode exits 1 on failure, and says why in an error event.
    const stdout = [stepFinish(), errorEvent('Unexpected server error.')].join('\n');

    const outcome = resolveOutcome({
      exitCode: 1,
      summary: summarise(stdout, 'opencode'),
      engine: 'opencode'
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.error, 'Unexpected server error.');
    assert.equal(outcome.retryable, true);
  });

  it('should_fail_an_opencode_error_event_even_when_the_process_exits_zero', () => {
    const outcome = resolveOutcome({
      exitCode: 0,
      summary: summarise(errorEvent('provider is not configured'), 'opencode'),
      engine: 'opencode'
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.error, 'provider is not configured');
  });

  it('should_fail_when_opencode_exits_zero_having_finished_no_step', () => {
    // The rule that protects against a silently truncated run, on both engines:
    // a stream with no terminal event has not confirmed anything.
    const outcome = resolveOutcome({
      exitCode: 0,
      summary: summarise(textEvent('working on it'), 'opencode'),
      engine: 'opencode'
    });

    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? '', /No result event/);
  });

  it('should_name_the_engine_that_failed_rather_than_always_claude', () => {
    const outcome = resolveOutcome({ exitCode: 2, summary: emptySummary(), engine: 'opencode' });

    assert.equal(outcome.error, 'opencode exited with code 2.');
  });

  it('should_name_the_engine_whose_credentials_were_rejected', () => {
    const outcome = resolveOutcome({
      exitCode: 1,
      summary: summarise(errorEvent('unauthorized'), 'opencode'),
      engine: 'opencode'
    });

    assert.equal(outcome.authFailure, true);
    assert.match(outcome.error ?? '', /the opencode CLI rejected your credentials/);
  });

  it('should_detect_an_opencode_auth_failure_from_its_status_code', () => {
    // The message opencode actually emits on a rejected login — observed
    // against 1.18.5 — says neither "unauthorized" nor "not logged in", so
    // every text pattern misses it and the status code is the only thing that
    // identifies it. Without this the run is filed as retryable, and an expired
    // login gets three retries an hour apart instead of being reported.
    const outcome = resolveOutcome({
      exitCode: 1,
      summary: summarise(
        errorEvent('Upstream request failed: [401] Provider returned error', 401),
        'opencode'
      ),
      engine: 'opencode'
    });

    assert.equal(outcome.authFailure, true);
    assert.equal(outcome.retryable, false);
  });
});

describe('resolveOutcome — authentication', () => {
  it('should_not_retry_a_run_that_failed_authentication', () => {
    // An expired token fails every task identically; three retries an hour
    // apart only delay the discovery by three hours.
    const stdout = resultEvent({ is_error: true, result: 'Invalid API key · Please run /login' });

    const outcome = resolveOutcome({ exitCode: 1, summary: summarise(stdout) });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.retryable, false);
    assert.equal(outcome.authFailure, true);
  });

  it('should_detect_an_auth_failure_from_the_api_error_status', () => {
    const stdout = resultEvent({ is_error: true, api_error_status: 401, result: 'request failed' });

    const outcome = resolveOutcome({ exitCode: 1, summary: summarise(stdout) });

    assert.equal(outcome.authFailure, true);
    assert.equal(outcome.retryable, false);
  });

  it('should_still_retry_an_ordinary_failure', () => {
    const stdout = resultEvent({ is_error: true, result: 'The plan referenced a missing file.' });

    const outcome = resolveOutcome({ exitCode: 1, summary: summarise(stdout) });

    assert.equal(outcome.retryable, true);
    assert.equal(outcome.authFailure, undefined);
  });

  it('should_not_misread_a_successful_run_that_merely_mentions_a_401', () => {
    // The agent writing *about* an auth error is not an auth error.
    const stdout = resultEvent({ result: 'Added handling for unauthorized 401 responses.' });

    const outcome = resolveOutcome({ exitCode: 0, summary: summarise(stdout) });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.authFailure, undefined);
  });

  it('should_preserve_session_and_cost_from_an_auth_failure', () => {
    const stdout = resultEvent({ is_error: true, result: 'Unauthorized' });

    const outcome = resolveOutcome({ exitCode: 1, summary: summarise(stdout) });

    assert.equal(outcome.sessionId, 'sess-1');
    assert.equal(outcome.costUsd, 0.17);
  });
});

describe('watchdogVerdict', () => {
  const MINUTE = 60_000;
  const IDLE = 15 * MINUTE;
  const MAX = 60 * MINUTE;
  const NOW = Date.parse('2026-07-26T12:00:00.000Z');

  const active = (overrides: Partial<Parameters<typeof watchdogVerdict>[0]> = {}) => ({
    startedAtMs: NOW - MINUTE,
    lastOutputAtMs: NOW - MINUTE,
    ...overrides
  });

  it('should_leave_a_healthy_run_alone', () => {
    assert.equal(watchdogVerdict(active(), NOW, IDLE, MAX), undefined);
  });

  it('should_kill_a_run_that_exceeded_the_idle_timeout', () => {
    const stalled = active({ lastOutputAtMs: NOW - 20 * MINUTE });

    assert.equal(watchdogVerdict(stalled, NOW, IDLE, MAX), 'idle');
  });

  it('should_kill_a_run_that_exceeded_the_maximum_runtime', () => {
    const overrunning = active({ startedAtMs: NOW - 90 * MINUTE, lastOutputAtMs: NOW });

    assert.equal(watchdogVerdict(overrunning, NOW, IDLE, MAX), 'runtime');
  });

  it('should_report_runtime_rather_than_idle_when_both_apply', () => {
    const both = active({ startedAtMs: NOW - 90 * MINUTE, lastOutputAtMs: NOW - 20 * MINUTE });

    assert.equal(watchdogVerdict(both, NOW, IDLE, MAX), 'runtime');
  });

  it('should_not_kill_a_run_that_only_just_resumed_after_a_long_suspend', () => {
    // Windows fires suspended timers on resume. A timer-based watchdog would
    // kill a task that had just woken and produced output.
    const justWoken = active({ startedAtMs: NOW - 8 * 60 * MINUTE, lastOutputAtMs: NOW });

    assert.equal(watchdogVerdict(justWoken, NOW, IDLE, 12 * 60 * MINUTE), undefined);
  });

  it('should_not_stack_a_second_kill_reason_on_a_dying_run', () => {
    const dying = active({ lastOutputAtMs: NOW - 20 * MINUTE, killReason: 'cancelled' as const });

    assert.equal(watchdogVerdict(dying, NOW, IDLE, MAX), undefined);
  });
});

describe('truncateError', () => {
  it('should_leave_a_short_message_unchanged', () => {
    assert.equal(truncateError('  boom  '), 'boom');
  });

  it('should_cap_an_oversized_message', () => {
    const outcome = truncateError('x'.repeat(ERROR_MAX_CHARS + 500));

    assert.equal(outcome.length, ERROR_MAX_CHARS + 3);
    assert.match(outcome, /\.\.\.$/);
  });
});

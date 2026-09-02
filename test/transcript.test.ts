import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Outcome } from '../src/outcome';
import {
  FinaliseOps,
  finaliseInterrupted,
  localStamp,
  parseLine,
  toAnsi,
  toMarkdown,
  transcriptFooter,
  transcriptHeader
} from '../src/transcript';

function assistantEvent(content: unknown[]): string {
  return JSON.stringify({ type: 'assistant', message: { content } });
}

function outcome(overrides: Partial<Outcome> = {}): Outcome {
  return { ok: true, denials: 0, retryable: false, ...overrides };
}

const CONTEXT = {
  fileName: 'nightly-audit.md',
  cwd: 'D:\\repo',
  engine: 'Claude Code',
  permissionMode: 'bypassPermissions',
  startedAt: new Date(2026, 6, 26, 21, 30),
  attempt: 1
};

describe('parseLine — recognising events', () => {
  it('should_ignore_a_line_that_is_not_json', () => {
    assert.deepEqual(parseLine('warming up...'), { events: [] });
  });

  it('should_ignore_a_truncated_json_line', () => {
    // Progress lines can be cut mid-stream; a parse failure must not throw.
    assert.deepEqual(parseLine('{"type":"assist'), { events: [] });
  });

  it('should_read_the_session_and_model_from_the_init_event', () => {
    const { events } = parseLine('{"type":"system","subtype":"init","session_id":"s1","model":"opus"}');

    assert.deepEqual(events, [{ kind: 'session', sessionId: 's1', model: 'opus' }]);
  });

  it('should_read_assistant_text_and_tool_calls_in_order', () => {
    const line = assistantEvent([
      { type: 'text', text: '  Checking the build.  ' },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }
    ]);

    const { events } = parseLine(line);

    assert.deepEqual(events, [
      { kind: 'text', text: 'Checking the build.' },
      { kind: 'tool', name: 'Bash', detail: 'npm test' }
    ]);
  });

  it('should_drop_empty_assistant_text_rather_than_emit_a_blank_line', () => {
    const { events } = parseLine(assistantEvent([{ type: 'text', text: '   ' }]));

    assert.deepEqual(events, []);
  });

  it('should_fold_the_result_line_so_the_runner_need_not_keep_the_stream', () => {
    // The whole point of the summary: it is what lets the runner throw away
    // every line instead of accumulating the stream in memory.
    const { summary } = parseLine('{"type":"result","num_turns":4,"total_cost_usd":0.23}');

    assert.equal(summary?.sawResult, true);
    assert.equal(summary?.numTurns, 4);
    assert.equal(summary?.costUsd, 0.23);
  });

  it('should_count_permission_denials_on_the_result_event', () => {
    const { events } = parseLine(
      '{"type":"result","num_turns":2,"permission_denials":[{"tool":"Bash"},{"tool":"Write"}]}'
    );

    assert.deepEqual(events, [{ kind: 'result', turns: 2, costUsd: undefined, denials: 2 }]);
  });
});

describe('parseLine — tool detail', () => {
  it('should_prefer_the_command_when_recording_a_shell_call', () => {
    const { events } = parseLine(
      assistantEvent([{ type: 'tool_use', name: 'Bash', input: { command: 'git status', timeout: 5 } }])
    );

    assert.equal(events[0].kind === 'tool' && events[0].detail, 'git status');
  });

  it('should_record_the_file_path_for_an_edit', () => {
    const { events } = parseLine(
      assistantEvent([{ type: 'tool_use', name: 'Edit', input: { file_path: 'D:\\repo\\src\\a.ts' } }])
    );

    assert.equal(events[0].kind === 'tool' && events[0].detail, 'D:\\repo\\src\\a.ts');
  });

  it('should_cap_a_pathological_tool_argument', () => {
    const { events } = parseLine(
      assistantEvent([{ type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(5000) } }])
    );

    const detail = events[0].kind === 'tool' ? (events[0].detail ?? '') : '';
    assert.ok(detail.length < 250, `detail was ${detail.length} chars`);
  });

  it('should_leave_detail_absent_when_no_recognised_field_is_present', () => {
    const { events } = parseLine(
      assistantEvent([{ type: 'tool_use', name: 'Mystery', input: { limit: 3 } }])
    );

    assert.deepEqual(events, [{ kind: 'tool', name: 'Mystery', detail: undefined }]);
  });
});

/**
 * The four event types a real `opencode run --format json` emitted, captured
 * from a run told to write a file and read it back. The mapping only has to
 * reach `TranscriptEvent`; everything downstream of that is already shared.
 */
describe('parseLine — opencode', () => {
  const event = (type: string, part: Record<string, unknown>) =>
    JSON.stringify({ type, timestamp: 1785790834801, sessionID: 'ses_1', part });

  it('should_ignore_a_truncated_opencode_line', () => {
    assert.deepEqual(parseLine('{"type":"tool_us', 'opencode'), { events: [] });
  });

  it('should_read_assistant_text', () => {
    const line = event('text', { type: 'text', text: '  Created the file.  ' });

    assert.deepEqual(parseLine(line, 'opencode').events, [
      { kind: 'text', text: 'Created the file.' }
    ]);
  });

  it('should_record_a_tool_call_and_what_it_touched', () => {
    // The transcript exists to answer "what did it touch?" — without this an
    // opencode transcript would be blind to every file edit and shell command.
    const line = event('tool_use', {
      type: 'tool',
      tool: 'write',
      state: { status: 'completed', input: { content: 'hi', filePath: '/tmp/hello.txt' } }
    });

    assert.deepEqual(parseLine(line, 'opencode').events, [
      { kind: 'tool', name: 'write', detail: '/tmp/hello.txt' }
    ]);
  });

  it('should_prefer_the_command_when_recording_an_opencode_shell_call', () => {
    const line = event('tool_use', {
      type: 'tool',
      tool: 'bash',
      state: { input: { command: 'npm test', description: 'run the suite' } }
    });

    const { events } = parseLine(line, 'opencode');

    assert.equal(events[0].kind === 'tool' && events[0].detail, 'npm test');
  });

  it('should_count_each_finished_step_as_a_turn_without_narrating_it', () => {
    // opencode reports per step, not per run. A "1 turn" line after every step
    // would be noise, so the totals go to the footer and nothing to the body.
    const line = event('step_finish', {
      type: 'step-finish',
      reason: 'stop',
      tokens: { total: 7943 },
      cost: 0.004
    });

    const { events, summary } = parseLine(line, 'opencode');

    assert.deepEqual(events, []);
    assert.equal(summary?.numTurns, 1);
    assert.equal(summary?.costUsd, 0.004);
    assert.equal(summary?.sawResult, true);
  });

  it('should_treat_an_error_event_as_a_terminal_failure', () => {
    const line = JSON.stringify({
      type: 'error',
      sessionID: 'ses_1',
      error: { name: 'UnknownError', data: { message: 'Unexpected server error.', ref: 'err_1' } }
    });

    const { summary } = parseLine(line, 'opencode');

    assert.equal(summary?.isError, true);
    assert.equal(summary?.sawResult, true);
    assert.equal(summary?.resultText, 'Unexpected server error.');
  });

  it('should_say_nothing_about_a_step_starting', () => {
    const line = event('step_start', { type: 'step-start' });

    const { events, summary } = parseLine(line, 'opencode');

    assert.deepEqual(events, []);
    assert.equal(summary?.sawResult, undefined);
  });

  it('should_not_read_an_opencode_stream_with_the_claude_parser', () => {
    // The engines share a shape, not a schema. Reading one as the other would
    // silently produce an empty transcript rather than fail.
    const line = event('text', { type: 'text', text: 'Created the file.' });

    assert.deepEqual(parseLine(line, 'claude').events, []);
  });
});

/**
 * Captured from `codex --ask-for-approval never exec --json --sandbox read-only`.
 * Codex reports a thread, completed items, and a turn summary rather than
 * Claude's assistant/result pair.
 */
describe('parseLine — codex', () => {
  it('should_ignore_a_truncated_codex_line', () => {
    assert.deepEqual(parseLine('{"type":"item.comp', 'codex'), { events: [] });
  });

  it('should_read_the_thread_id_as_the_session', () => {
    const line = '{"type":"thread.started","thread_id":"thread_1"}';

    const { events, summary } = parseLine(line, 'codex');

    assert.deepEqual(events, [{ kind: 'session', sessionId: 'thread_1', model: '' }]);
    assert.equal(summary?.sessionId, 'thread_1');
  });

  it('should_read_completed_agent_messages_as_text', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: '  OK  ' }
    });

    const { events, summary } = parseLine(line, 'codex');

    assert.deepEqual(events, [{ kind: 'text', text: 'OK' }]);
    assert.equal(summary?.resultText, 'OK');
  });

  it('should_record_a_codex_command_execution', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'command_execution', command: 'npm test' }
    });

    assert.deepEqual(parseLine(line, 'codex').events, [
      { kind: 'tool', name: 'command_execution', detail: 'npm test' }
    ]);
  });

  it('should_record_a_codex_file_change', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_2', type: 'file_change', path: 'src/agents.ts' }
    });

    assert.deepEqual(parseLine(line, 'codex').events, [
      { kind: 'tool', name: 'file_change', detail: 'src/agents.ts' }
    ]);
  });

  it('should_mark_a_completed_turn_as_the_terminal_result', () => {
    const line = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 14600, output_tokens: 17 }
    });

    const { events, summary } = parseLine(line, 'codex');

    assert.deepEqual(events, [{ kind: 'result', turns: 1, costUsd: undefined, denials: 0 }]);
    assert.equal(summary?.numTurns, 1);
    assert.equal(summary?.sawResult, true);
  });

  it('should_treat_a_failed_turn_as_a_terminal_failure', () => {
    const line = JSON.stringify({
      type: 'turn.failed',
      error: { message: 'Not authenticated.', status: 401 }
    });

    const { summary } = parseLine(line, 'codex');

    assert.equal(summary?.isError, true);
    assert.equal(summary?.sawResult, true);
    assert.equal(summary?.resultText, 'Not authenticated.');
    assert.equal(summary?.apiErrorStatus, '401');
  });
});

describe('toAnsi and toMarkdown — one parse, two renderings', () => {
  it('should_render_assistant_text_identically_in_both', () => {
    const event = { kind: 'text', text: 'Found three failures.' } as const;

    assert.equal(toAnsi(event), 'Found three failures.');
    assert.equal(toMarkdown(event), 'Found three failures.');
  });

  it('should_fence_a_tool_argument_so_backticks_cannot_break_the_document', () => {
    const event = { kind: 'tool', name: 'Bash', detail: 'echo `whoami`' } as const;

    const markdown = toMarkdown(event) ?? '';

    assert.ok(markdown.includes('```\necho `whoami`\n```'), markdown);
  });

  it('should_omit_the_session_event_from_the_transcript_since_the_header_has_it', () => {
    const event = { kind: 'session', sessionId: 's1', model: 'opus' } as const;

    assert.ok(toAnsi(event));
    assert.equal(toMarkdown(event), undefined);
  });

  it('should_omit_the_result_event_from_the_transcript_since_the_footer_has_it', () => {
    const event = { kind: 'result', turns: 3, costUsd: 0.2, denials: 0 } as const;

    assert.ok(toAnsi(event));
    assert.equal(toMarkdown(event), undefined);
  });
});

describe('transcriptHeader', () => {
  it('should_record_the_conditions_the_run_executed_under', () => {
    const header = transcriptHeader(CONTEXT);

    assert.ok(header.startsWith('# nightly-audit.md'));
    assert.ok(header.includes('2026-07-26 21:30'));
    assert.ok(header.includes('D:\\repo'));
    assert.ok(header.includes('bypassPermissions'));
  });

  it('should_say_default_when_no_model_is_pinned', () => {
    assert.ok(transcriptHeader(CONTEXT).includes('| Model | default |'));
  });

  it('should_name_the_engine_the_run_went_through', () => {
    // Two engines mean "Sonnet 5" and "opencode default" are no longer enough
    // on their own to say what actually ran.
    assert.ok(transcriptHeader(CONTEXT).includes('| Engine | Claude Code |'));
    assert.ok(transcriptHeader({ ...CONTEXT, engine: 'opencode' }).includes('| Engine | opencode |'));
  });

  it('should_note_the_attempt_only_when_this_is_a_retry', () => {
    assert.ok(!transcriptHeader(CONTEXT).includes('Attempt'));
    assert.ok(transcriptHeader({ ...CONTEXT, attempt: 3 }).includes('retry 2'));
  });

  it('should_escape_a_pipe_so_it_cannot_split_a_table_cell', () => {
    const header = transcriptHeader({ ...CONTEXT, cwd: 'D:\\a|b' });

    assert.ok(header.includes('D:\\a\\|b'));
  });
});

describe('transcriptFooter', () => {
  it('should_state_success_with_turns_cost_and_duration', () => {
    const footer = transcriptFooter(outcome({ numTurns: 4, costUsd: 0.2312 }), 192_000);

    assert.ok(footer.includes('**Completed**'));
    assert.ok(footer.includes('4 turns'));
    assert.ok(footer.includes('$0.2312'));
    assert.ok(footer.includes('3m 12s'));
  });

  it('should_state_the_error_when_the_run_failed', () => {
    const footer = transcriptFooter(
      outcome({ ok: false, error: 'Killed — exceeded the maximum runtime.' }),
      60_000
    );

    assert.ok(footer.includes('**Failed**'));
    assert.ok(footer.includes('exceeded the maximum runtime'));
  });

  it('should_call_out_permission_denials_prominently_on_an_otherwise_successful_run', () => {
    // The failure mode this exists for: exit 0, work silently not done.
    const footer = transcriptFooter(outcome({ numTurns: 2, denials: 3 }), 10_000);

    assert.ok(footer.includes('**Completed**'));
    assert.ok(footer.includes('3 tool call(s) were blocked'));
    assert.ok(footer.includes('did not run'));
  });

  it('should_stay_silent_about_denials_when_there_were_none', () => {
    assert.ok(!transcriptFooter(outcome({ numTurns: 1 }), 1000).includes('blocked'));
  });
});

describe('localStamp', () => {
  it('should_format_local_wall_clock_time_zero_padded', () => {
    assert.equal(localStamp(new Date(2026, 0, 5, 9, 7)), '2026-01-05 09:07');
  });
});

describe('finaliseInterrupted', () => {
  const TRANSCRIPT = '/results/nightly/2026-01-05-213045.md';
  const REASON = 'Interrupted — VS Code closed during execution.';

  /** Records what was done rather than doing it, so failures can be injected. */
  const spyOps = (overrides: Partial<FinaliseOps> = {}) => {
    const appended: string[] = [];
    const renames: Array<[string, string]> = [];
    const warnings: string[] = [];
    const ops: FinaliseOps = {
      exists: () => true,
      append: (_p, text) => void appended.push(text),
      rename: (from, to) => void renames.push([from, to]),
      warn: (message) => void warnings.push(message),
      ...overrides
    };
    return { ops, appended, renames, warnings };
  };

  it('should_do_nothing_when_the_run_never_had_a_transcript', () => {
    // A results folder that could not be written to leaves resultPath undefined.
    const { ops, appended, renames } = spyOps();

    assert.equal(finaliseInterrupted(undefined, REASON, 1000, ops), undefined);
    assert.deepEqual(appended, []);
    assert.deepEqual(renames, []);
  });

  it('should_leave_a_transcript_alone_when_the_file_is_already_gone', () => {
    const { ops, appended, renames } = spyOps({ exists: () => false });

    assert.equal(finaliseInterrupted(TRANSCRIPT, REASON, 1000, ops), TRANSCRIPT);
    assert.deepEqual(appended, []);
    assert.deepEqual(renames, []);
  });

  it('should_append_a_footer_then_rename_the_transcript_to_failed', () => {
    const { ops, appended, renames } = spyOps();

    const result = finaliseInterrupted(TRANSCRIPT, REASON, 90_000, ops);

    assert.equal(appended.length, 1);
    assert.equal(renames.length, 1);
    assert.equal(renames[0][0], TRANSCRIPT);
    assert.match(renames[0][1], /-failed\.md$/);
    assert.equal(result, renames[0][1]);
  });

  it('should_record_the_reason_and_the_duration_in_the_footer', () => {
    const { ops, appended } = spyOps();

    finaliseInterrupted(TRANSCRIPT, REASON, 90_000, ops);

    assert.ok(appended[0].includes('**Failed**'));
    assert.ok(appended[0].includes(REASON));
    assert.ok(appended[0].includes('1m 30s'));
  });

  it('should_keep_the_original_path_when_the_rename_fails', () => {
    // A locked or read-only results folder must not lose the transcript that
    // was just written, nor take the scheduler down on startup.
    const { ops, warnings } = spyOps({
      rename: () => {
        throw new Error('EPERM');
      }
    });

    assert.equal(finaliseInterrupted(TRANSCRIPT, REASON, 1000, ops), TRANSCRIPT);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /EPERM/);
  });

  it('should_not_attempt_a_rename_when_the_footer_could_not_be_written', () => {
    // Renaming to `-failed` after a failed append would advertise a finalised
    // transcript that has no Outcome section in it.
    const { ops, renames, warnings } = spyOps({
      append: () => {
        throw new Error('ENOSPC');
      }
    });

    assert.equal(finaliseInterrupted(TRANSCRIPT, REASON, 1000, ops), TRANSCRIPT);
    assert.deepEqual(renames, []);
    assert.equal(warnings.length, 1);
  });
});

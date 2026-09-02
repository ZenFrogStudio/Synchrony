import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ASK_SERVER,
  ASK_TOOLS,
  buildArgs,
  enabledPlanSteps,
  explainCommand,
  generateCommand,
  mcpClientConfig,
  preflightError,
  shellKind,
  Shell
} from '../src/launch';
import { AgentId, PermissionMode } from '../src/types';

const PLAN = 'D:\\plans\\refactor.md';
const CWD = 'D:\\repo';

const launchable = (permissionMode: PermissionMode = 'acceptEdits', model?: string) => ({
  filePath: PLAN,
  cwd: CWD,
  permissionMode,
  model
});

const onEngine = (agent: AgentId, permissionMode: PermissionMode = 'acceptEdits', model?: string) => ({
  ...launchable(permissionMode, model),
  agent
});

/** Everything present and readable, unless a test says otherwise. */
const allExist = () => true;
const readsPlan = () => '# Do the thing\n';

describe('buildArgs', () => {
  it('should_always_run_headless_with_a_streamed_result', () => {
    const args = buildArgs(launchable());

    assert.ok(args.includes('-p'), 'without -p the CLI blocks on interactive approval');
    assert.deepEqual(args.slice(1, 4), ['--output-format', 'stream-json', '--verbose']);
  });

  it('should_pass_the_selected_permission_mode_through', () => {
    const args = buildArgs(launchable('plan'));

    assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  });

  it('should_pass_the_bypass_flag_only_for_bypass_permissions', () => {
    // The flag enables the capability rather than applying it, so the two must
    // travel together. Shipped unverified in 0.4.0.
    const bypass = buildArgs(launchable('bypassPermissions'));
    const normal = buildArgs(launchable('acceptEdits'));

    assert.ok(bypass.includes('--allow-dangerously-skip-permissions'));
    assert.ok(!normal.includes('--allow-dangerously-skip-permissions'));
  });

  it('should_omit_the_model_flag_when_no_model_is_pinned', () => {
    assert.ok(!buildArgs(launchable()).includes('--model'));
  });

  it('should_pin_the_model_when_one_is_chosen', () => {
    const args = buildArgs(launchable('acceptEdits', 'opus'));

    assert.equal(args[args.indexOf('--model') + 1], 'opus');
  });

  it('should_never_place_the_prompt_on_the_command_line', () => {
    // The plan travels on stdin: no argv length limit, no shell escaping.
    const args = buildArgs(launchable('acceptEdits', 'opus'));

    assert.ok(!args.some((arg) => arg.includes(PLAN)));
  });

  it('should_treat_a_series_with_no_engine_as_a_claude_series', () => {
    // What every series stored before engines existed means, which is why
    // adding the field needed no migration.
    assert.deepEqual(buildArgs(launchable()), buildArgs(onEngine('claude')));
  });
});

describe('buildArgs — opencode', () => {
  it('should_ask_for_the_ndjson_stream_the_transcript_is_parsed_from', () => {
    const args = buildArgs(onEngine('opencode'));

    assert.deepEqual(args.slice(0, 3), ['run', '--format', 'json']);
  });

  it('should_name_the_working_directory_rather_than_relying_on_the_process_cwd', () => {
    // opencode runs its tools through a server of its own that resolves the
    // project root independently, so it does not inherit the spawned process's
    // working directory. Without --dir a task pointed at one repo edits
    // whichever repo opencode picked — with permissions wide open.
    const args = buildArgs(onEngine('opencode'));

    assert.equal(args[args.indexOf('--dir') + 1], CWD);
  });

  it('should_never_emit_a_claude_flag', () => {
    // The two CLIs share a stream shape, not a command line.
    const args = buildArgs(onEngine('opencode', 'bypassPermissions', 'opencode/big-pickle'));

    for (const flag of ['-p', '--output-format', '--verbose', '--permission-mode', '--model']) {
      assert.ok(!args.includes(flag), `${flag} means nothing to opencode`);
    }
  });

  it('should_auto_approve_for_every_mode_that_means_do_not_stop_and_ask', () => {
    // opencode has one approval control where Claude has six. Without --auto an
    // unattended run blocks on a prompt nobody is awake to answer.
    for (const mode of ['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk'] as PermissionMode[]) {
      assert.ok(buildArgs(onEngine('opencode', mode)).includes('--auto'), mode);
    }
  });

  it('should_withhold_auto_approval_in_plan_and_manual_modes', () => {
    for (const mode of ['plan', 'manual'] as PermissionMode[]) {
      assert.ok(!buildArgs(onEngine('opencode', mode)).includes('--auto'), mode);
    }
  });

  it('should_pin_the_model_with_opencodes_own_flag', () => {
    const args = buildArgs(onEngine('opencode', 'auto', 'opencode/north-mini-code-free'));

    assert.equal(args[args.indexOf('-m') + 1], 'opencode/north-mini-code-free');
  });

  it('should_omit_the_model_flag_when_no_model_is_pinned', () => {
    assert.ok(!buildArgs(onEngine('opencode')).includes('-m'));
  });

  it('should_never_place_the_prompt_on_the_command_line', () => {
    // `opencode run --format json` reads its prompt from stdin, same as claude.
    const args = buildArgs(onEngine('opencode', 'auto', 'opencode/big-pickle'));

    assert.ok(!args.some((arg) => arg.includes(PLAN)));
  });

  it('should_pass_a_working_directory_containing_spaces_as_one_argument', () => {
    // `runner.ts` quotes every argv entry on Windows for exactly this — under
    // `shell: true` Node quotes nothing, so an unquoted path would arrive as
    // three arguments.
    const spaced = 'C:\\My Projects\\site';
    const args = buildArgs({ ...onEngine('opencode'), cwd: spaced });

    assert.equal(args[args.indexOf('--dir') + 1], spaced);
  });
});

describe('buildArgs — codex', () => {
  it('should_run_codex_exec_with_the_json_stream_the_transcript_is_parsed_from', () => {
    const args = buildArgs(onEngine('codex'));

    assert.deepEqual(args.slice(0, 4), ['--ask-for-approval', 'on-request', 'exec', '--json']);
  });

  it('should_name_the_working_directory_rather_than_relying_on_the_process_cwd', () => {
    const args = buildArgs(onEngine('codex'));

    assert.equal(args[args.indexOf('--cd') + 1], CWD);
  });

  it('should_never_emit_a_claude_or_opencode_flag', () => {
    const args = buildArgs(onEngine('codex', 'auto', 'gpt-5.3-codex'));

    for (const flag of ['-p', '--output-format', '--verbose', '--permission-mode', '--dir', '-m']) {
      assert.ok(!args.includes(flag), `${flag} belongs to another engine`);
    }
  });

  it('should_run_manual_and_plan_modes_read_only_with_approval_available', () => {
    for (const mode of ['manual', 'plan'] as PermissionMode[]) {
      const args = buildArgs(onEngine('codex', mode));

      assert.equal(args[args.indexOf('--ask-for-approval') + 1], 'on-request');
      assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    }
  });

  it('should_allow_edits_but_keep_approval_available_for_accept_edits', () => {
    const args = buildArgs(onEngine('codex', 'acceptEdits'));

    assert.equal(args[args.indexOf('--ask-for-approval') + 1], 'on-request');
    assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
  });

  it('should_not_stop_to_ask_in_auto_and_dont_ask_modes', () => {
    for (const mode of ['auto', 'dontAsk'] as PermissionMode[]) {
      const args = buildArgs(onEngine('codex', mode));

      assert.equal(args[args.indexOf('--ask-for-approval') + 1], 'never');
      assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
    }
  });

  it('should_use_codexs_explicit_bypass_flag_only_for_bypass_permissions', () => {
    const bypass = buildArgs(onEngine('codex', 'bypassPermissions'));
    const normal = buildArgs(onEngine('codex', 'auto'));

    assert.ok(bypass.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(!normal.includes('--dangerously-bypass-approvals-and-sandbox'));
  });

  it('should_pin_the_model_with_codexs_model_flag', () => {
    const args = buildArgs(onEngine('codex', 'auto', 'gpt-5.3-codex'));

    assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.3-codex');
  });

  it('should_omit_the_model_flag_when_no_model_is_pinned', () => {
    assert.ok(!buildArgs(onEngine('codex')).includes('--model'));
  });

  it('should_never_place_the_prompt_on_the_command_line', () => {
    const args = buildArgs(onEngine('codex', 'auto', 'gpt-5.3-codex'));

    assert.ok(!args.some((arg) => arg.includes(PLAN)));
  });
});

const TASK = 'D:\\plans\\tasks\\refactor-the-auth-module.md';
const LIBRARY = 'D:\\plans';
const STAGING = 'D:\\plans\\.pending\\ab12cd';

const generatable = (overrides: Partial<Parameters<typeof generateCommand>[0]> = {}) => ({
  exe: 'claude',
  sourcePath: PLAN,
  allowDir: LIBRARY,
  shell: 'posix' as Shell,
  ...overrides
});

describe('generateCommand', () => {
  it('should_name_the_source_file_rather_than_carrying_its_text', () => {
    const command = generateCommand(generatable());

    // The source is named, not pasted: a task can grow past one line, a plan body
    // can be tens of kilobytes, and neither survives a shell prompt.
    assert.ok(command.includes(PLAN), 'Claude is told which file to read');
    assert.ok(!command.includes('\n'), 'a multi-line body would break the command');
  });

  it('should_write_the_plan_somewhere_other_than_the_task_file', () => {
    // The task view's whole point: a one-line task must never be the thing that
    // gets overwritten by the plan generated from it.
    const command = generateCommand(generatable({ sourcePath: TASK, destDir: STAGING }));

    assert.ok(command.includes(`save the approved plan as a new .md file in ${STAGING}`));
    assert.ok(!command.includes(`overwrite that same file`));
  });

  it('should_ask_claude_to_name_the_file_after_the_change', () => {
    // Chronos cannot name the plan before it exists — guessing from the task
    // text is what filled the library with truncated request lines.
    const command = generateCommand(generatable({ sourcePath: TASK, destDir: STAGING }));

    assert.ok(command.includes('Name that file with a three word description'));
  });

  it('should_not_ask_for_a_name_when_overwriting_in_place', () => {
    // The manager's own button re-plans a library plan in place, and that plan
    // already has a name the user chose.
    const command = generateCommand(generatable());

    assert.ok(command.includes('overwrite that same file with the approved plan'));
    assert.ok(!command.includes('Name that file'));
  });

  it('should_ask_for_the_closing_step_when_steps_are_enabled', () => {
    // Without it an overnight run leaves the repo with new behaviour, no version
    // bump, no changelog entry and nothing committed.
    const command = generateCommand(
      generatable({ steps: ['version', 'changelog', 'commit'] })
    );

    assert.ok(
      command.includes(
        'Finish the plan with a closing step that bumps the project version, ' +
          'adds a matching changelog entry and commits the result to git.'
      )
    );
  });

  it('should_list_only_the_enabled_steps', () => {
    const command = generateCommand(generatable({ steps: ['commit'] }));

    assert.ok(command.includes('commits the result to git'));
    assert.ok(!command.includes('changelog'), 'a switched-off step must not be asked for');
  });

  it('should_keep_the_steps_in_a_fixed_order_whatever_order_they_arrive_in', () => {
    // The order is the table's, not the caller's: record before commit, so the
    // commit picks up the version bump.
    const command = generateCommand(generatable({ steps: ['commit', 'version'] }));

    assert.ok(command.indexOf('bumps the project version') < command.indexOf('commits the result'));
  });

  it('should_omit_the_closing_sentence_when_every_step_is_off', () => {
    for (const steps of [[], undefined]) {
      const command = generateCommand(generatable({ steps }));

      assert.ok(!command.includes('Finish the plan'), `steps: ${JSON.stringify(steps)}`);
    }
  });

  it('should_tell_the_planner_the_closing_step_belongs_in_the_plan', () => {
    // The planning session runs in plan mode. Without this clause it bumps the
    // version and commits during planning instead of writing the step down.
    const command = generateCommand(generatable({ steps: ['commit'] }));

    assert.ok(command.includes('belongs in the plan you write, not something you do now'));
  });

  it('should_keep_the_instruction_free_of_shell_metacharacters', () => {
    // The instruction is one quoted argument typed into a live shell prompt:
    // interactive bash expands `!`, PowerShell expands `$`, and both run a
    // backtick or quote. Nothing here may be any of those — which is why every
    // closing step is switched on here: a phrase carrying an apostrophe or an em
    // dash cannot reach the table without failing this.
    const command = generateCommand(
      generatable({
        sourcePath: TASK,
        destDir: STAGING,
        steps: ['tests', 'version', 'changelog', 'rebuild', 'reinstall', 'commit']
      })
    );

    assert.ok(!command.includes('`'), 'a backtick would run a command');
    assert.ok(!command.includes('$'), 'PowerShell would expand it');
    assert.ok(!command.includes('!'), 'interactive bash would expand it');
    // An em dash cannot survive cmd.exe's code page.
    assert.ok(!/[^\x20-\x7e]/.test(command), 'the command must be plain ASCII');
  });

  it('should_put_the_instruction_where_no_variadic_flag_can_eat_it', () => {
    // `--add-dir`, `--mcp-config` and `--allowedTools` are all variadic in the
    // CLI, so each consumes arguments until it meets another flag. An
    // instruction trailing after one is read as one more directory and the
    // session opens with no prompt at all — silently, with the terminal sitting
    // there empty. That is how it shipped broken whenever no model was pinned,
    // because `--add-dir` was then the last flag before the instruction.
    for (const options of [{}, { model: 'opus' }, { askConfigPath: ASK_CONFIG }]) {
      const command = generateCommand(generatable(options));
      const label = JSON.stringify(options);

      assert.ok(command.includes("'claude' 'Read the file at"), `${label}: instruction is not first`);
      // Nothing variadic may precede it, which is the property that actually
      // matters — the position is only how it is achieved.
      assert.ok(command.indexOf("'Read the file at") < command.indexOf('--add-dir'), label);
    }
  });

  it('should_always_plan_regardless_of_any_other_permission_mode', () => {
    // The series may be set to bypassPermissions; this writes a plan, it does
    // not carry one out.
    const command = generateCommand(generatable());

    assert.ok(command.includes('--permission-mode plan'));
    assert.ok(!command.includes('--allow-dangerously-skip-permissions'));
  });

  it('should_omit_the_model_flag_when_no_model_is_pinned', () => {
    assert.ok(!generateCommand(generatable()).includes('--model'));
  });

  it('should_pin_the_model_when_one_is_chosen', () => {
    assert.ok(generateCommand(generatable({ model: 'opus' })).includes('--model opus'));
  });

  it('should_grant_access_to_the_library_that_holds_both_paths', () => {
    // The working directory is the repo; both the task and its staging folder
    // live in the library, outside it. One grant covers both, because `tasks/`
    // and `.pending/` are inside the library — without it Claude can neither
    // read nor write.
    const command = generateCommand(generatable({ sourcePath: TASK, destDir: STAGING }));

    assert.equal(command.match(/--add-dir/g)?.length, 1);
    assert.ok(command.includes(`--add-dir '${LIBRARY}'`));
  });

  it('should_quote_a_path_containing_spaces_for_each_shell', () => {
    const spaced = 'C:\\My Plans';
    const quoted: Record<Shell, string> = {
      powershell: `--add-dir '${spaced}'`,
      cmd: `--add-dir "${spaced}"`,
      posix: `--add-dir '${spaced}'`
    };

    for (const shell of ['powershell', 'cmd', 'posix'] as Shell[]) {
      const command = generateCommand(generatable({ allowDir: spaced, shell }));

      assert.ok(
        command.includes(quoted[shell]),
        `${shell} should wrap the path as ${quoted[shell]}`
      );
    }
  });

  it('should_call_a_quoted_executable_with_the_powershell_call_operator', () => {
    // Without &, PowerShell reads a quoted string at the start of a line as a
    // value rather than a command.
    const exe = 'C:\\Program Files\\claude.exe';
    const command = generateCommand(generatable({ exe, shell: 'powershell' }));

    assert.ok(command.startsWith(`& '${exe}'`));
  });

  it('should_escape_a_single_quote_in_a_posix_path', () => {
    const command = generateCommand(
      generatable({ allowDir: "/home/me/o'brien", shell: 'posix' })
    );

    assert.ok(command.includes(`--add-dir '/home/me/o'\\''brien'`));
  });

  it('should_escape_a_single_quote_in_a_powershell_path', () => {
    const command = generateCommand(
      generatable({ allowDir: "C:\\o'brien", shell: 'powershell' })
    );

    assert.ok(command.includes(`--add-dir 'C:\\o''brien'`));
  });
});

const ASK_CONFIG = 'D:\\plans\\.pending\\ab12cd\\mcp.json';

const routed = (overrides: Partial<Parameters<typeof generateCommand>[0]> = {}) =>
  generateCommand(
    generatable({ sourcePath: TASK, destDir: STAGING, askConfigPath: ASK_CONFIG, ...overrides })
  );

describe('generateCommand — questions routed through Chronos', () => {
  it('should_register_the_ask_server_with_the_cli', () => {
    // Without this the session has no `chronos-ask` tools at all, and the
    // instruction below names tools that do not exist.
    assert.ok(routed().includes(`--mcp-config '${ASK_CONFIG}'`));
  });

  it('should_allowlist_exactly_the_tools_the_session_may_call', () => {
    // Anything not on this list stops and asks, and nobody is there to answer.
    const command = routed();

    assert.ok(command.includes(`--allowedTools '${ASK_TOOLS.join(',')}'`));
    for (const tool of ASK_TOOLS) {
      assert.ok(command.includes(tool), `${tool} is not allowlisted`);
    }
  });

  it('should_name_both_tools_in_the_instruction_as_well_as_the_allowlist', () => {
    // The allowlist says what it *may* call; the instruction is what makes it
    // actually call them rather than talking to the terminal.
    const command = routed();

    assert.ok(command.includes(`calling mcp__${ASK_SERVER}__ask_user`));
    assert.ok(command.includes(`call mcp__${ASK_SERVER}__submit_plan`));
    // Clarifying questions still route; only the final approval went.
    assert.ok(
      command.includes(
        `Ask me anything you need to first, and ask it only by calling mcp__${ASK_SERVER}__ask_user`
      )
    );
  });

  it('should_say_why_the_terminal_is_no_use', () => {
    // A model that reads "ask me anything" with a terminal in front of it will
    // use the terminal, and the question then waits for a keyboard nobody is
    // sitting at.
    assert.ok(routed().includes('I am not at this terminal'));
  });

  it('should_not_stop_and_ask_for_the_plan_to_be_approved', () => {
    // The plan is editable in the panel and cannot run until it is scheduled, so
    // waiting for a yes only parks a finished session.
    const command = routed();

    assert.ok(!command.includes('wait for my answer'));
    assert.ok(!command.includes('When I approve'));
    assert.ok(!command.includes('approve it first, '));
    assert.ok(command.includes('Do not ask me to approve it first'));
  });

  it('should_tell_the_session_how_to_carry_on_waiting', () => {
    // Each ask_user call is short so it fits inside the client's own tool
    // timeout; carrying on is the session calling again with the same id.
    assert.ok(routed().includes('call it again with the same id'));
  });

  it('should_never_tell_a_routed_session_to_write_the_plan_to_a_file', () => {
    // The plan arrives through submit_plan. Two ways to deliver it is one way
    // for a session to deliver it twice, or to the wrong place.
    const command = routed();

    assert.ok(!command.includes('save the approved plan as a new .md file'));
    assert.ok(!command.includes('overwrite that same file'));
    assert.ok(!command.includes('ending in .md'));
  });

  it('should_still_ask_for_a_name_describing_the_change', () => {
    // submit_plan takes a title rather than a file name, but the naming rule is
    // the same one: do not just repeat the request back.
    const command = routed();

    assert.ok(
      command.includes('Title it with a three word description of the outcome the plan produces')
    );
    assert.ok(command.includes('do not just repeat the words of the request'));
  });

  it('should_run_in_default_mode_because_plan_mode_refuses_mcp_tools', () => {
    // Measured, not assumed: in plan mode the CLI refuses an MCP tool call
    // outright even when it is allowlisted, so a routed session could neither
    // ask its question nor deliver its plan. `default` lets the two allowlisted
    // tools through and still stops and asks for everything else.
    const command = routed();

    assert.ok(command.includes('--permission-mode default'));
    assert.ok(!command.includes('--permission-mode plan'));
    assert.ok(!command.includes('--allow-dangerously-skip-permissions'));
  });

  it('should_still_ask_for_the_closing_step', () => {
    const command = routed({ steps: ['version', 'commit'] });

    assert.ok(command.includes('bumps the project version'));
    assert.ok(command.includes('belongs in the plan you write, not something you do now'));
  });

  it('should_keep_the_routed_instruction_free_of_shell_metacharacters', () => {
    // Same rule as the instruction it replaces: one quoted argument typed into
    // a live shell. Underscores are safe in all three shells; a backtick around
    // a tool name would not be.
    const command = routed({
      steps: ['tests', 'version', 'changelog', 'rebuild', 'reinstall', 'commit']
    });

    assert.ok(!command.includes('`'), 'a backtick would run a command');
    assert.ok(!command.includes('$'), 'PowerShell would expand it');
    assert.ok(!command.includes('!'), 'interactive bash would expand it');
    assert.ok(!/[^\x20-\x7e]/.test(command), 'the command must be plain ASCII');
  });

  it('should_quote_the_config_path_for_each_shell', () => {
    const spaced = 'C:\\My Plans\\.pending\\ab12cd\\mcp.json';
    const quoted: Record<Shell, string> = {
      powershell: `--mcp-config '${spaced}'`,
      cmd: `--mcp-config "${spaced}"`,
      posix: `--mcp-config '${spaced}'`
    };

    for (const shell of ['powershell', 'cmd', 'posix'] as Shell[]) {
      assert.ok(routed({ askConfigPath: spaced, shell }).includes(quoted[shell]), shell);
    }
  });

  it('should_still_grant_access_to_the_library', () => {
    assert.ok(routed().includes(`--add-dir '${LIBRARY}'`));
  });

  it('should_still_pin_the_model_when_one_is_chosen', () => {
    assert.ok(routed({ model: 'opus' }).includes('--model opus'));
  });

  it('should_leave_the_unrouted_command_exactly_as_it_was', () => {
    // The setting is off, or the config could not be written. This is the path
    // every existing user is on, and it must not shift by a byte.
    const command = generateCommand(generatable({ sourcePath: TASK, destDir: STAGING }));

    assert.equal(
      command,
      "'claude' " +
        "'Read the file at D:\\plans\\tasks\\refactor-the-auth-module.md. Treat what it says " +
        'as the request, work out how to carry it out, and write an implementation plan for ' +
        'it. Ask me anything you need to first. When I approve the plan, save the approved ' +
        'plan as a new .md file in D:\\plans\\.pending\\ab12cd, written as instructions for an ' +
        'agent that will carry it out later with nobody watching, and change nothing else. ' +
        'Name that file with a three word description of the outcome the plan produces, in ' +
        'lower case with hyphens instead of spaces, ending in .md, for example ' +
        "add-monthly-repeat.md. Use exactly three words and do not just repeat the words of " +
        "the request.' " +
        "--permission-mode plan --add-dir 'D:\\plans'"
    );
  });

  it('should_mention_neither_mcp_flag_when_the_session_is_not_routed', () => {
    const command = generateCommand(generatable({ sourcePath: TASK, destDir: STAGING }));

    assert.ok(!command.includes('--mcp-config'));
    assert.ok(!command.includes('--allowedTools'));
    assert.ok(!command.includes('mcp__'));
  });
});

const explainable = (overrides: Partial<Parameters<typeof explainCommand>[0]> = {}) => ({
  exe: 'claude',
  sourcePath: TASK,
  allowDir: LIBRARY,
  shell: 'posix' as Shell,
  ...overrides
});

describe('explainCommand', () => {
  it('should_name_the_task_file_rather_than_carrying_its_text', () => {
    const command = explainCommand(explainable());

    assert.ok(command.includes(TASK), 'Claude is told which file to read');
    assert.ok(!command.includes('\n'), 'a multi-line body would break the command');
  });

  it('should_ask_for_context_to_be_gathered_before_the_answer', () => {
    // A task captured by an agent is one line of shorthand. Explaining it from
    // the line alone is a guess; the project is where the answer is.
    assert.ok(explainCommand(explainable()).includes('Gather whatever context you need'));
  });

  it('should_ask_for_plain_language_rather_than_a_summary_of_the_line', () => {
    const command = explainCommand(explainable());

    assert.ok(command.includes('in plain language a non-specialist would follow'));
    assert.ok(command.includes('Briefly explain any technical term'));
  });

  it('should_ask_why_it_is_needed_and_what_the_alternatives_are', () => {
    // The three questions the button exists to answer: what, why, and what else.
    const command = explainCommand(explainable());

    assert.ok(command.includes('what the change actually is'));
    assert.ok(command.includes('why it is needed and what goes wrong if it is never done'));
    assert.ok(command.includes('what the alternatives are, including doing nothing'));
  });

  it('should_never_ask_for_a_plan_a_name_or_a_closing_step', () => {
    // None of the planning machinery is shared. An explanation that ended by
    // writing a plan file would put a document in the library nobody approved.
    const command = explainCommand(explainable({ model: 'opus' }));

    assert.ok(!command.includes('save the approved plan'));
    assert.ok(!command.includes('Finish the plan'));
    assert.ok(!command.includes('three word'));
    assert.ok(!command.includes('mcp__'));
  });

  it('should_tell_the_session_to_change_nothing', () => {
    const command = explainCommand(explainable());

    assert.ok(command.includes('Do not create, edit or delete any file'));
    assert.ok(command.includes('do not carry the change out'));
  });

  it('should_run_in_default_mode_rather_than_plan_mode', () => {
    // Plan mode ends by offering its work through ExitPlanMode, and approving
    // that prompt would set the agent off implementing the very task you asked
    // it to explain. `default` is an ordinary conversation, and every write tool
    // still stops and asks — with you sitting there.
    const command = explainCommand(explainable());

    assert.ok(command.includes('--permission-mode default'));
    assert.ok(!command.includes('--permission-mode plan'));
    assert.ok(!command.includes('--allow-dangerously-skip-permissions'));
  });

  it('should_put_the_instruction_where_no_variadic_flag_can_eat_it', () => {
    // `--add-dir` is variadic, so a trailing instruction is read as one more
    // directory and the terminal opens with no prompt in it at all.
    for (const options of [{}, { model: 'opus' }]) {
      const command = explainCommand(explainable(options));
      const label = JSON.stringify(options);

      assert.ok(command.includes("'claude' 'Read the file at"), `${label}: instruction is not first`);
      assert.ok(command.indexOf("'Read the file at") < command.indexOf('--add-dir'), label);
    }
  });

  it('should_grant_access_to_the_library_that_holds_the_task', () => {
    // The working directory is the repo; the task lives in the folder's
    // `.chronos` root, outside it. Without the grant Claude cannot read it.
    const command = explainCommand(explainable());

    assert.equal(command.match(/--add-dir/g)?.length, 1);
    assert.ok(command.includes(`--add-dir '${LIBRARY}'`));
  });

  it('should_quote_a_path_containing_spaces_for_each_shell', () => {
    const spaced = 'C:\\My Plans';
    const quoted: Record<Shell, string> = {
      powershell: `--add-dir '${spaced}'`,
      cmd: `--add-dir "${spaced}"`,
      posix: `--add-dir '${spaced}'`
    };

    for (const shell of ['powershell', 'cmd', 'posix'] as Shell[]) {
      const command = explainCommand(explainable({ allowDir: spaced, shell }));

      assert.ok(command.includes(quoted[shell]), `${shell} should wrap the path as ${quoted[shell]}`);
    }
  });

  it('should_call_a_quoted_executable_with_the_powershell_call_operator', () => {
    const exe = 'C:\\Program Files\\claude.exe';
    const command = explainCommand(explainable({ exe, shell: 'powershell' }));

    assert.ok(command.startsWith(`& '${exe}'`));
  });

  it('should_omit_the_model_flag_when_no_model_is_pinned', () => {
    assert.ok(!explainCommand(explainable()).includes('--model'));
  });

  it('should_pin_the_model_when_one_is_chosen', () => {
    assert.ok(explainCommand(explainable({ model: 'opus' })).includes('--model opus'));
  });

  it('should_keep_the_instruction_free_of_shell_metacharacters', () => {
    // The same rule as every other instruction here: one quoted argument typed
    // into a live shell prompt. No apostrophe and no em dash either, both of
    // which are easy to reach for in a sentence about explaining something.
    const command = explainCommand(explainable({ model: 'opus' }));

    assert.ok(!command.includes('`'), 'a backtick would run a command');
    assert.ok(!command.includes('$'), 'PowerShell would expand it');
    assert.ok(!command.includes('!'), 'interactive bash would expand it');
    assert.ok(!/[^\x20-\x7e]/.test(command), 'the command must be plain ASCII');
  });
});

describe('enabledPlanSteps', () => {
  it('should_default_to_version_changelog_and_commit', () => {
    // What a fresh install does: record what changed and commit it, without
    // spending an unattended run on a test suite or a build nobody asked for.
    const steps = enabledPlanSteps((_key, fallback) => fallback);

    assert.deepEqual(steps, ['version', 'changelog', 'commit']);
  });

  it('should_include_the_opt_in_steps_when_they_are_switched_on', () => {
    const steps = enabledPlanSteps(() => true);

    assert.deepEqual(steps, ['tests', 'version', 'changelog', 'rebuild', 'reinstall', 'commit']);
  });

  it('should_return_nothing_when_every_step_is_switched_off', () => {
    assert.deepEqual(enabledPlanSteps(() => false), []);
  });

  it('should_read_each_step_under_its_own_settings_key', () => {
    // Catches a key renamed in package.json but not here, which would silently
    // fall back to the default and ignore what the user actually chose.
    const asked: string[] = [];

    enabledPlanSteps((key, fallback) => {
      asked.push(key);
      return fallback;
    });

    assert.deepEqual(asked, [
      'planStep.tests',
      'planStep.version',
      'planStep.changelog',
      'planStep.rebuild',
      'planStep.reinstall',
      'planStep.commit'
    ]);
  });

  it('should_treat_rebuild_and_reinstall_as_two_independent_steps', () => {
    // They are one habit but two decisions: a library rebuilds and never
    // installs, and turning one on must not drag the other along.
    const rebuildOnly = enabledPlanSteps((key) => key === 'planStep.rebuild');
    const reinstallOnly = enabledPlanSteps((key) => key === 'planStep.reinstall');

    assert.deepEqual(rebuildOnly, ['rebuild']);
    assert.deepEqual(reinstallOnly, ['reinstall']);
  });
});

describe('shellKind', () => {
  it('should_treat_pwsh_as_powershell', () => {
    assert.equal(shellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32'), 'powershell');
  });

  it('should_treat_cmd_as_cmd', () => {
    assert.equal(shellKind('C:\\WINDOWS\\System32\\cmd.exe', 'win32'), 'cmd');
  });

  it('should_treat_git_bash_on_windows_as_posix', () => {
    // Git Bash and WSL run on Windows but quote like POSIX.
    assert.equal(shellKind('C:\\Program Files\\Git\\bin\\bash.exe', 'win32'), 'posix');
  });

  it('should_treat_any_shell_off_windows_as_posix', () => {
    assert.equal(shellKind('/bin/zsh', 'darwin'), 'posix');
    assert.equal(shellKind('/usr/bin/fish', 'linux'), 'posix');
  });

  it('should_fall_back_to_powershell_for_an_unknown_windows_shell', () => {
    // VS Code's own default profile on Windows.
    assert.equal(shellKind('C:\\tools\\nushell\\nu.exe', 'win32'), 'powershell');
  });
});

describe('mcp client config', () => {
  // The awkward paths on purpose, as in `mcp-clients.test.ts`: a config that
  // parses cleanly and points at nothing fails silently at both ends.
  const SERVER_JS = 'C:\\Users\\Ada Lovelace\\globalStorage\\z3n.chronos\\mcp-server.js';
  const FOLDER = 'D:\\03-Software\\My Project';

  const parse = (json: string) => JSON.parse(json) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };

  it('should_name_the_plain_server_chronos_and_run_it_with_node', () => {
    const config = parse(mcpClientConfig('chronos', SERVER_JS, ['--folder', FOLDER]));

    assert.deepEqual(Object.keys(config.mcpServers), ['chronos']);
    assert.equal(config.mcpServers.chronos.command, 'node');
    assert.deepEqual(config.mcpServers.chronos.args, [SERVER_JS, '--folder', FOLDER]);
  });

  it('should_key_the_ask_config_off_the_name_it_is_given', () => {
    // The name the tools are registered under has to be the name the
    // `--allowedTools` allowlist uses, so the key can never be a literal.
    const config = parse(
      mcpClientConfig(ASK_SERVER, SERVER_JS, [
        '--folder',
        FOLDER,
        '--ask-only',
        '--pending',
        'D:\\session',
        '--source',
        'tidy the inbox'
      ])
    );

    assert.deepEqual(Object.keys(config.mcpServers), [ASK_SERVER]);
    assert.deepEqual(config.mcpServers[ASK_SERVER].args, [
      SERVER_JS,
      '--folder',
      FOLDER,
      '--ask-only',
      '--pending',
      'D:\\session',
      '--source',
      'tidy the inbox'
    ]);
  });

  it('should_produce_json_a_client_can_actually_parse', () => {
    // These are Windows paths full of backslashes; built by hand, one unescaped
    // separator makes a file that parses and points nowhere.
    const json = mcpClientConfig('chronos', SERVER_JS, ['--folder', FOLDER]);

    assert.doesNotThrow(() => JSON.parse(json));
    assert.ok(json.includes('\\\\'), 'the path separators are not JSON-escaped');
  });
});

describe('preflightError', () => {
  it('should_pass_when_the_plan_and_directory_are_both_present', () => {
    assert.equal(preflightError(launchable(), allExist, readsPlan), undefined);
  });

  it('should_fail_preflight_when_the_plan_file_was_deleted', () => {
    const error = preflightError(launchable(), (p) => p !== PLAN, readsPlan);

    assert.match(String(error), /no longer exists/);
  });

  it('should_fail_preflight_when_the_working_directory_is_gone', () => {
    const error = preflightError(launchable(), (p) => p !== CWD, readsPlan);

    assert.match(String(error), /Working directory/);
  });

  it('should_fail_preflight_when_the_plan_file_is_empty', () => {
    const error = preflightError(launchable(), allExist, () => '   \n\t ');

    assert.match(String(error), /empty/);
  });

  it('should_fail_preflight_when_the_plan_file_cannot_be_read', () => {
    const error = preflightError(launchable(), allExist, () => {
      throw new Error('EACCES');
    });

    assert.match(String(error), /Could not read/);
  });

  it('should_not_read_the_plan_when_it_does_not_exist', () => {
    let reads = 0;
    preflightError(launchable(), () => false, () => {
      reads++;
      return '';
    });

    assert.equal(reads, 0);
  });
});

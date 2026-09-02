import { PermissionMode, TaskSeries } from './types';

/**
 * How a run is started, minus the starting. Pure — no `vscode` import — so the
 * argument construction and the pre-flight rules are directly testable.
 *
 * The prompt is absent from every argv below: it travels on stdin for both
 * engines, so there is no length limit and nothing to escape.
 */

/** The fields of a series that actually shape a launch. */
type Launchable = Pick<TaskSeries, 'filePath' | 'cwd' | 'permissionMode' | 'model'>;

type Runnable = Pick<TaskSeries, 'permissionMode' | 'model' | 'agent' | 'cwd'>;

/**
 * The permission modes that mean "do not stop and ask". opencode has one
 * approval control where Claude has six, so these all collapse onto `--auto`.
 */
const OPENCODE_AUTO_MODES: readonly PermissionMode[] = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'dontAsk'
];

export function buildArgs(series: Runnable): string[] {
  switch (series.agent) {
    case 'opencode':
      return opencodeArgs(series);
    case 'codex':
      return codexArgs(series);
    default:
      return claudeArgs(series);
  }
}

function claudeArgs(series: Runnable): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    series.permissionMode
  ];

  // bypassPermissions is only honoured when the CLI is separately told to allow
  // it; the flag makes the capability available rather than applying it.
  if (series.permissionMode === 'bypassPermissions') {
    args.push('--allow-dangerously-skip-permissions');
  }
  if (series.model) {
    args.push('--model', series.model);
  }
  return args;
}

function opencodeArgs(series: Runnable): string[] {
  // `--dir` is not belt and braces. opencode runs its tools through a local
  // server of its own that resolves the project root independently, so it does
  // *not* inherit the spawned process's working directory — verified against
  // 1.18.5, where a run spawned with cwd set to one folder edited another. A
  // task pointed at one repo would otherwise quietly edit whichever repo
  // opencode felt like, with permissions wide open.
  const args = ['run', '--format', 'json', '--dir', series.cwd];

  // Without this an unattended run blocks on an approval prompt nobody is awake
  // to answer, and the watchdog eventually kills it for idling.
  if (OPENCODE_AUTO_MODES.includes(series.permissionMode)) {
    args.push('--auto');
  }
  if (series.model) {
    args.push('-m', series.model);
  }
  return args;
}

function codexArgs(series: Runnable): string[] {
  const exec = ['exec', '--json', '--cd', series.cwd];

  switch (series.permissionMode) {
    case 'bypassPermissions':
      exec.splice(1, 0, '--dangerously-bypass-approvals-and-sandbox');
      break;
    case 'auto':
    case 'dontAsk':
      exec.push('--sandbox', 'workspace-write');
      exec.unshift('--ask-for-approval', 'never');
      break;
    case 'acceptEdits':
      exec.push('--sandbox', 'workspace-write');
      exec.unshift('--ask-for-approval', 'on-request');
      break;
    case 'manual':
    case 'plan':
      exec.push('--sandbox', 'read-only');
      exec.unshift('--ask-for-approval', 'on-request');
      break;
  }

  if (series.model) {
    exec.push('--model', series.model);
  }
  return exec;
}

/** The three argument-quoting rules that exist among the shells VS Code opens. */
export type Shell = 'powershell' | 'cmd' | 'posix';

/**
 * Classifies `vscode.env.shell`. Defaults to PowerShell on Windows because that
 * is VS Code's own default profile there.
 */
export function shellKind(shellPath: string, platform: NodeJS.Platform): Shell {
  if (platform !== 'win32') {
    return 'posix';
  }
  const name = shellPath.toLowerCase();
  if (/powershell|pwsh/.test(name)) {
    return 'powershell';
  }
  // Git Bash and WSL, both of which run on Windows but quote like POSIX.
  if (/bash|zsh|wsl/.test(name)) {
    return 'posix';
  }
  if (name.includes('cmd.exe')) {
    return 'cmd';
  }
  return 'powershell';
}

/**
 * There is no quoting form that works in all three: single quotes are literal in
 * PowerShell and POSIX but mean nothing in cmd, and double quotes work in cmd
 * but expand `$` in PowerShell.
 */
function quote(shell: Shell, value: string): string {
  if (shell === 'powershell') {
    // PowerShell single quotes are literal; '' escapes one.
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (shell === 'cmd') {
    // cmd has no escape character inside quotes, and a Windows path cannot
    // contain a double quote, so stripping one is a guard rather than a loss.
    return `"${value.replace(/"/g, '')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A step a generated plan is asked to end with, and whether it is on by default. */
export type PlanStepId = 'tests' | 'version' | 'changelog' | 'rebuild' | 'reinstall' | 'commit';

/**
 * Order matters and is fixed here rather than taken from the caller: verify,
 * then record, then build, then install, then commit. Each phrase completes "a closing step
 * that ...", and every one of them is ASCII with no shell metacharacter,
 * because the whole instruction is one argument typed into a live shell.
 */
export const PLAN_STEPS: readonly { id: PlanStepId; phrase: string; onByDefault: boolean }[] = [
  { id: 'tests', phrase: 'runs the project test suite and gets it passing', onByDefault: false },
  { id: 'version', phrase: 'bumps the project version', onByDefault: true },
  { id: 'changelog', phrase: 'adds a matching changelog entry', onByDefault: true },
  { id: 'rebuild', phrase: 'rebuilds the project', onByDefault: false },
  {
    id: 'reinstall',
    phrase: 'reinstalls the project so the new build is the one running',
    onByDefault: false
  },
  { id: 'commit', phrase: 'commits the result to git', onByDefault: true }
];

/** The enabled steps, in table order, read through a settings getter. */
export function enabledPlanSteps(
  read: (key: string, fallback: boolean) => boolean
): PlanStepId[] {
  return PLAN_STEPS.filter((step) => read(`planStep.${step.id}`, step.onByDefault)).map(
    (step) => step.id
  );
}

/**
 * The MCP server name a routed planning session talks to Chronos through, and
 * the tools it is allowed to call.
 *
 * Exported and derived rather than written out, because these names appear in
 * three places that must agree: the `--allowedTools` allowlist, the instruction
 * that tells the session what to call, and the registrations in
 * `mcp-server.ts`. Let those drift and the session sits on a permission prompt
 * nobody is there to answer, with nothing in any log to say why —
 * `source-guards.test.ts` checks the third one against these.
 */
export const ASK_SERVER = 'chronos-ask';
export const ASK_TOOLS = ['ask_user', 'submit_plan'].map((tool) => `mcp__${ASK_SERVER}__${tool}`);

/**
 * The JSON an MCP client needs in order to spawn the Chronos server.
 *
 * One builder for both callers — the clipboard snippet a user pastes into their
 * own client (`mcp-clients.ts`), and the `mcp.json` a planning session is
 * spawned with (`tasks.ts`) — so the key, the shape and the command cannot
 * drift apart between them. Only the arguments differ, which is the only thing
 * that should. `extra` is for the one or two clients that want a timeout key
 * alongside the command; everything else about the entry is identical.
 *
 * `node` rather than the runtime the editor happens to be using: it is what
 * every client's own documentation assumes, and what the README already tells
 * people to type.
 */
export function mcpClientConfig(
  name: string,
  serverPath: string,
  args: readonly string[],
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify(
    { mcpServers: { [name]: { command: 'node', args: [serverPath, ...args], ...extra } } },
    null,
    2
  );
}

export interface GenerateOptions {
  exe: string;
  /** The file Claude reads the request from — a library plan, or a sidebar task. */
  sourcePath: string;
  /**
   * A folder the approved plan is saved into, under a file name Claude chooses.
   * Omitted means overwrite `sourcePath`, which is what the manager's own button
   * does; the task view passes a folder so a one-line task is never the thing
   * that gets overwritten, and so the plan arrives named after the change it
   * makes rather than after the request that asked for it.
   */
  destDir?: string;
  /** Granted with --add-dir. Must contain both paths above, since the working
   *  directory is the repo and neither file usually sits inside it. */
  allowDir: string;
  model?: string;
  shell: Shell;
  /**
   * The steps the plan should end with. Omitted or empty means no closing
   * sentence at all, which is what every toggle being off means.
   */
  steps?: PlanStepId[];
  /**
   * An `mcp.json` registering the `chronos-ask` server. Present means route the
   * session's questions through it, so they can be answered from somewhere other
   * than this terminal; absent means the session asks in the terminal as it
   * always has, and every argument below is exactly what it was.
   */
  askConfigPath?: string;
  /**
   * Split the approved work into a run of stage plans rather than writing one.
   * Terminal only: `submit_plan` delivers exactly one plan, so a routed session
   * has nowhere to put the rest of a series, and `askConfigPath` wins here.
   */
  series?: boolean;
}

/**
 * The enabled steps as an English list, or '' when nothing is enabled. Each one
 * completes "a closing step that ...".
 */
function stepList(steps: PlanStepId[]): string {
  // Filtered against the table rather than mapped over the argument, so the
  // order the caller happened to pass them in cannot leak into the sentence.
  const phrases = PLAN_STEPS.filter((step) => steps.includes(step.id)).map((step) => step.phrase);
  if (!phrases.length) {
    return '';
  }

  return phrases.length === 1
    ? phrases[0]
    : `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`;
}

/**
 * The sentence appended to the instruction, or '' when nothing is enabled.
 *
 * The last clause is not padding: the planning session itself runs in plan mode,
 * and without it the session bumps the version and commits during planning
 * instead of writing the step into the plan it is meant to produce.
 */
function closingSentence(steps: PlanStepId[]): string {
  const list = stepList(steps);
  if (!list) {
    return '';
  }

  return (
    ` Finish the plan with a closing step that ${list}. ` +
    'This step belongs in the plan you write, not something you do now.'
  );
}

/**
 * The same steps, placed for a chain rather than for one plan.
 *
 * The two kinds of step want different homes. A chained run leaves the repo dirty
 * for the next link, so committing belongs at the end of *every* plan; bumping the
 * version, writing the changelog entry and rebuilding describe the finished work,
 * so they belong at the end of the last one only. Doing either everywhere would
 * mean five version bumps for one change, or a stage handing the next one an
 * uncommitted tree.
 */
function seriesClosingSentence(steps: PlanStepId[]): string {
  const everyPlan = steps.includes('commit')
    ? ' Finish every plan in the series with a closing step that commits the result to ' +
      'git, so the next plan in the series starts from a clean tree.'
    : '';

  const rest = stepList(steps.filter((step) => step !== 'commit'));
  const lastPlan = rest
    ? ` Finish the last plan in the series with a closing step that ${rest}. ` +
      'These steps belong in the plans you write, not something you do now.'
    : '';

  return everyPlan + lastPlan;
}

/**
 * The instruction for a session that asks in the terminal, as it always has.
 *
 * No `!`, `$`, backtick or quote of its own: interactive bash expands `!` and
 * PowerShell expands `$`, so the only thing `quote` has to survive is a path.
 */
function terminalInstruction(
  sourcePath: string,
  destDir: string | undefined,
  steps: PlanStepId[]
): string {
  const destination = destDir
    ? `save the approved plan as a new .md file in ${destDir}`
    : 'overwrite that same file with the approved plan';

  const naming =
    ' Name that file with a three word description of the outcome the plan ' +
    'produces, in lower case with hyphens instead of spaces, ending in .md, ' +
    'for example add-monthly-repeat.md. Use exactly three words and do not ' +
    'just repeat the words of the request.';

  return (
    `Read the file at ${sourcePath}. Treat what it says as the request, ` +
    'work out how to carry it out, and write an implementation plan for it. ' +
    `Ask me anything you need to first. When I approve the plan, ${destination}, ` +
    'written as instructions for an agent that will carry it out later with ' +
    'nobody watching, and change nothing else.' +
    (destDir ? naming : '') +
    closingSentence(steps)
  );
}

/**
 * The file a series session writes last, and what Chronos watches for.
 *
 * Exported so the instruction and the watcher in `tasks.ts` cannot drift apart.
 * Deliberately not a `.md`, so `library.listPlans` cannot mistake it for one of
 * the stage plans — the same trick `mcp.json` already relies on in that folder.
 */
export const SERIES_MANIFEST = 'series.txt';

/**
 * The instruction for a session that splits one task into a run of plans.
 *
 * A single-plan session is finished the moment a `.md` lands. A series has no
 * such moment — the files arrive one at a time with the model thinking in
 * between — so the session is asked to write the manifest last, and that file is
 * both the completion signal and the authoritative running order.
 *
 * The two digit number in each name is not decoration either: if the tab closes
 * before the manifest is written, file-name order is the only order left, and
 * the number is what makes it the right one.
 *
 * Same two rules as every instruction in this file: plain ASCII with no shell
 * metacharacter, and the instruction ahead of every flag.
 */
function seriesInstruction(sourcePath: string, destDir: string, steps: PlanStepId[]): string {
  return (
    `Read the file at ${sourcePath}. Treat what it says as the request, ` +
    'work out how to carry it out, and ask me anything you need to first. ' +
    'When I approve, split the work into as many separate plans as it naturally ' +
    'needs, each one a stage that can be carried out and finished on its own, in ' +
    `the order they must run. Save each stage as its own .md file in ${destDir}, ` +
    'written as instructions for an agent that will carry it out later with ' +
    'nobody watching, and change nothing else. Name each file with a two digit ' +
    'number for its position, then a three word description of the outcome that ' +
    'stage produces, in lower case with hyphens instead of spaces, ending in .md, ' +
    'for example 01-add-monthly-repeat.md. Use exactly three words after the ' +
    'number and do not just repeat the words of the request. When every stage ' +
    `file is written, and only then, write one last file called ${SERIES_MANIFEST} ` +
    'in that same folder listing the stage file names in run order, one per line ' +
    'and nothing else. Chronos reads that file as the signal that the series is ' +
    'finished.' +
    seriesClosingSentence(steps)
  );
}

/**
 * The instruction for a session whose user is somewhere else.
 *
 * Both ends of the conversation move: the questions go out through `ask_user`,
 * and the finished plan comes back through `submit_plan` rather than through a
 * file the session writes itself. Naming the tools and saying *why* is
 * load-bearing — a model that reads "ask me anything" with a terminal in front
 * of it will use the terminal, and the question then waits for a keyboard
 * nobody is sitting at.
 *
 * There is no approval step. The plan is delivered the moment it is written,
 * because it lands in the library, where it can be read and edited, and nothing
 * in the library runs until a person schedules it. Waiting for a yes only
 * stranded a finished session.
 *
 * Same ASCII rule as above: this is one argument typed into a live shell.
 */
function routedInstruction(sourcePath: string, steps: PlanStepId[]): string {
  const [ask, submit] = ASK_TOOLS;

  return (
    `Read the file at ${sourcePath}. Treat what it says as the request, ` +
    'work out how to carry it out, and write an implementation plan for it. ' +
    `Ask me anything you need to first, and ask it only by calling ${ask} - ` +
    'I am not at this terminal and a question asked any other way will not ' +
    `reach me. When the plan is ready, call ${submit} with it, written as ` +
    'instructions for an agent that will carry it out later with nobody ' +
    'watching, and change nothing else. Do not ask me to approve it first - ' +
    'I read it and change it in the Chronos panel, and nothing runs until I ' +
    'schedule it. Title it with a three word ' +
    'description of the outcome the plan produces, in lower case with hyphens ' +
    'instead of spaces, for example add-monthly-repeat. Use exactly three words ' +
    'and do not just repeat the words of the request. If ask_user comes back ' +
    'unanswered, call it again with the same id; only if that keeps happening ' +
    'should you ask me here in the terminal instead.' +
    closingSentence(steps)
  );
}

/**
 * The command line that opens an interactive planning session on a file.
 *
 * The source text is deliberately absent: it is named, not pasted. A plan body is
 * multi-line and can be tens of kilobytes, cmd.exe caps a command line at 8191
 * characters, and newlines cannot survive a shell prompt at all. A path is one
 * line and quotes cleanly, and Claude reads the file itself.
 *
 * The mode follows the entry point, because the two cannot be had at once. The
 * Tasks view's **Generate plan** button never passes `askConfigPath`, so it is
 * always `--permission-mode plan`: a session you are sitting at, which writes a
 * plan and does not carry one out, whatever the series is set to run as. The
 * palette's **Generate Plan (Answer Remotely)** passes one, and therefore cannot
 * plan.
 *
 * That cost is measured rather than assumed — plan mode refuses an MCP tool call
 * outright, allowlisted or not (`Cannot call mcp__chronos-ask__ask_user while in
 * plan mode`), which would leave a routed session unable to ask its question or
 * deliver its plan. `--allowedTools` does not override it. So a routed session
 * runs in `default` instead, where the two allowlisted tools go through without
 * a prompt and everything else still stops and asks. Nobody is there to approve
 * those, so an unattended session cannot make an edit either way — the mode
 * changes what it may call, not what it may change.
 */
export function generateCommand(options: GenerateOptions): string {
  const { exe, sourcePath, destDir, allowDir, model, shell, steps = [], askConfigPath } = options;
  const q = (value: string) => quote(shell, value);

  // A series needs somewhere to write several files, so without a staging folder
  // it is not a series — it falls back to the ordinary one-plan instruction.
  const instruction = askConfigPath
    ? routedInstruction(sourcePath, steps)
    : options.series && destDir
      ? seriesInstruction(sourcePath, destDir, steps)
      : terminalInstruction(sourcePath, destDir, steps);

  // PowerShell reads a quoted string at the start of a line as a value, not a
  // command; & is what makes it run.
  const command = shell === 'powershell' ? `& ${q(exe)}` : q(exe);

  // The instruction goes *first*, ahead of every flag, and that position is
  // load-bearing rather than stylistic. `--add-dir`, `--mcp-config` and
  // `--allowedTools` are all declared variadic by the CLI
  // (`--add-dir <directories...>`), so each one goes on consuming arguments
  // until it meets another flag: an instruction trailing after one is read as
  // one more directory, and the session opens with no prompt at all. That is
  // how it fails today whenever no model is pinned, silently, with the terminal
  // sitting at an empty prompt.
  //
  // Leading, it cannot be swallowed by anything, in any of the three shells. A
  // `--` separator would also work, but not portably — cmd needs it bare and
  // PowerShell only passes it through quoted, and a rule that subtle is worth
  // avoiding when moving the argument does the same job.
  const args = [q(instruction), '--permission-mode', askConfigPath ? 'default' : 'plan'];

  args.push('--add-dir', q(allowDir));
  if (askConfigPath) {
    args.push('--mcp-config', q(askConfigPath), '--allowedTools', q(ASK_TOOLS.join(',')));
  }
  if (model) {
    args.push('--model', model);
  }

  return `${command} ${args.join(' ')}`;
}

export interface ExplainOptions {
  exe: string;
  /** The task file Claude reads the request from. */
  sourcePath: string;
  /** Granted with --add-dir, as for a planning session. */
  allowDir: string;
  model?: string;
  shell: Shell;
}

/**
 * The command line that opens a read-only session explaining a captured task.
 *
 * Same shape as `generateCommand` and none of its machinery: nothing is written,
 * so there is no staging folder, no naming rule and no closing step. A task that
 * arrived through the MCP server is one line of somebody else's shorthand, and
 * this is the only way to find out what it means without committing to planning
 * or running it.
 *
 * Same two rules as every instruction in this file: plain ASCII with no shell
 * metacharacter, and the instruction ahead of every flag so `--add-dir` cannot
 * swallow it.
 */
export function explainCommand(options: ExplainOptions): string {
  const { exe, sourcePath, allowDir, model, shell } = options;
  const q = (value: string) => quote(shell, value);

  const instruction =
    `Read the file at ${sourcePath}. It is a task captured for this project, ` +
    'and it may have been written by an AI agent rather than by a person. ' +
    'Gather whatever context you need from this project first, then explain it ' +
    'to me here in the terminal: what the change actually is, in plain language ' +
    'a non-specialist would follow; why it is needed and what goes wrong if it ' +
    'is never done; and what the alternatives are, including doing nothing, ' +
    'with your view on which is best. Briefly explain any technical term you ' +
    'have to use. Do not create, edit or delete any file, do not write a plan, ' +
    'and do not carry the change out - this is an explanation only. Stay open ' +
    'afterwards so I can ask follow-up questions.';

  const command = shell === 'powershell' ? `& ${q(exe)}` : q(exe);

  // `default`, deliberately, and not `plan`. A plan-mode session ends by
  // offering its work through ExitPlanMode, and approving that prompt would set
  // the agent off *implementing* the very task you asked it to explain. An
  // ordinary conversation has no such exit, and every write tool still stops and
  // asks — with you sitting right there, which is the difference from a run
  // nobody is watching.
  const args = [q(instruction), '--permission-mode', 'default', '--add-dir', q(allowDir)];
  if (model) {
    args.push('--model', model);
  }

  return `${command} ${args.join(' ')}`;
}

/**
 * Why this run cannot start, or undefined if it can. Every one of these is a
 * permanent condition — the same missing file would fail identically an hour
 * later — so the caller must not retry on any of them.
 *
 * `exists` and `readFile` are injected so the rules can be tested without
 * touching a real filesystem.
 */
export function preflightError(
  series: Launchable,
  exists: (path: string) => boolean,
  readFile: (path: string) => string
): string | undefined {
  if (!exists(series.filePath)) {
    return `Plan file no longer exists: ${series.filePath}`;
  }
  if (!exists(series.cwd)) {
    return `Working directory no longer exists: ${series.cwd}`;
  }

  let prompt: string;
  try {
    prompt = readFile(series.filePath);
  } catch (err) {
    return `Could not read plan file: ${String(err)}`;
  }
  if (!prompt.trim()) {
    return 'Plan file is empty.';
  }

  return undefined;
}

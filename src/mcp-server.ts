import { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { wouldCycle } from './chain';
import * as library from './library';
import { readLock } from './lock';
import {
  planAnswers,
  planCwd,
  planQuestion,
  planSeriesOverrides,
  planSeriesUpdate,
  planTiming,
  QUEUED_NOTE,
  ScheduleWhen,
  schedulerIsLive
} from './mcp-tools';
import {
  listQuestions,
  newQuestionId,
  QuestionFile,
  readQuestion,
  recordAnswers,
  writeQuestion
} from './questions';
import { pathsFor, ensureRoot, ChronosPaths } from './roots';
import { createSeries, stampRepeatEnd } from './series';
import { readState, updateState } from './state-file';
import { ChronosState, TaskRun, TaskSeries } from './types';

/**
 * Chronos as an MCP server: the door any coding agent drives it through.
 *
 * Spawned as a child process by the agent (Claude Code, Codex, Cursor), scoped
 * to one project folder given as `--folder`, and speaking JSON-RPC over stdio.
 * It never talks to VS Code and never opens a port — it reads and writes the
 * same `.chronos` tree the extension does, and the open window notices.
 *
 * It holds no state. Every call re-reads the folder and writes back through
 * `updateState`, whose read-modify-write is exactly what lets two editor windows
 * share one schedule; a server process is one more writer of that kind.
 *
 * //Steps to completion:
 *
 *   //Resolve the project folder from --folder, defaulting to cwd;
 *   //Register the read tools, which never create anything on disk;
 *   //Register the write tools, each one going through mcp-tools.ts first;
 *   //Register the ask tools, which carry a question to a user who is elsewhere;
 *   //Serve over stdio, logging to stderr only.
 *
 * It wears two hats, and `--ask-only` is which one. Without it this is the
 * project's general-purpose server, the one a user registers in Claude Desktop
 * or Claude Code. With it, it is the private back-channel of a single planning
 * session: `ask_user` to reach a user who is not at the terminal, `submit_plan`
 * to hand back the result, and nothing that can put anything on the schedule.
 *
 * Two containment rules live here, at the filesystem edge, and neither is in
 * `mcp-tools.ts` because both are about paths rather than about rules:
 *
 * - **A plan is addressed by name, never by path.** Every name is resolved
 *   through `library.planPath`, which throws on anything escaping the library —
 *   so `schedule_plan` cannot be aimed at an arbitrary file on this disk.
 * - **A run is pointed inside `--folder`, never outside it.** `cwd` is the one
 *   path an agent can still name, and it is what a run can actually reach, so
 *   `planCwd` holds it to this project the way `planPath` holds the plan.
 * - **Writes stay under `--folder`'s `.chronos`,** and the tree is created on
 *   the first write rather than at start-up, so an agent merely listing an
 *   unconfigured project does not litter it.
 *
 * Nothing here may write to stdout: that is the transport, and one stray
 * `console.log` corrupts the protocol mid-session. `log.ts` imports `vscode` and
 * cannot be used, so `note()` below writes to stderr directly.
 */

///////////////////////////*Process setup*////////////////////////////

/**
 * Stamped in by `esbuild.js` from `package.json`, because a version written here
 * by hand is one nobody remembers to change — and this is what the server
 * announces to every client that connects. The fallback is what the test build
 * sees, which does not run esbuild.
 */
const VERSION = process.env.CHRONOS_VERSION ?? '0.0.0-dev';

/**
 * Retries for a series an agent schedules. The manifest default for
 * `chronos.maxRetries`, restated rather than read: settings live in VS Code and
 * this process has no way to reach them. A caller who wants something else
 * passes `maxRetries`, and the manager can change it afterwards either way.
 */
const DEFAULT_MAX_RETRIES = 3;

/** stderr, because stdout is the wire. The agent surfaces this in its own log. */
function note(text: string): void {
  process.stderr.write(`[chronos-mcp] ${text}\n`);
}

/**
 * The value after `flag`, or undefined. A value that looks like another flag is
 * treated as absent, so a missing argument cannot silently swallow the next one.
 */
function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  const value = at >= 0 ? argv[at + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

const ARGV = process.argv.slice(2);

/**
 * The project folder this server speaks for, fixed for the life of the process.
 * One folder per server, matching the extension: a schedule belongs to a
 * project, and an agent is already working in one.
 */
const FOLDER = path.resolve(argValue(ARGV, '--folder') ?? process.cwd());

/**
 * A folder that does not exist is a typo in a client config, not an instruction
 * to create one. Checked here rather than at the first write, because by then
 * `ensureRoot` has already built the chain and there is nothing left to refuse.
 */
function requireFolder(folder: string): void {
  let found = false;
  try {
    found = fs.statSync(folder).isDirectory();
  } catch {
    found = false;
  }
  if (!found) {
    note(`--folder is not a folder that exists: ${folder}`);
    process.exit(1);
  }
}

requireFolder(FOLDER);

/**
 * Narrows the surface to what a planning session needs: `ask_user` to reach the
 * user, and `submit_plan` to deliver the result. Nothing that can schedule.
 *
 * Two things fall out of that. An unattended session cannot put anything on the
 * schedule even if it decides to, and — since the user's own agent config
 * usually already registers a full `chronos` server — the session is not handed
 * two overlapping tool lists to choose between.
 */
const ASK_ONLY = ARGV.includes('--ask-only');

/**
 * Where `submit_plan` writes: the staging folder of the session that spawned
 * this server. Given once, at spawn — no path ever comes off the wire. Absent
 * means the tool is not registered at all.
 */
const PENDING = argValue(ARGV, '--pending');

/** What this session is working on, stamped onto every question it asks. */
const SOURCE = argValue(ARGV, '--source');

const paths = (): ChronosPaths => pathsFor(FOLDER);

/** Called before every write, never before a read. See the header. */
function ensureWritable(): ChronosPaths {
  const resolved = paths();
  ensureRoot(resolved);
  return resolved;
}

///////////////////////////*Replies*////////////////////////////

/**
 * `permissionMode` is declared on both write tools purely so it can be refused.
 *
 * Leaving it off the schema is not the same thing: zod strips a key it does not
 * declare, so the argument would never reach `mcp-tools.ts` and the agent would
 * get a plain success for a call that quietly did not do what it asked. Wrong in
 * both directions — the task is safe either way, but the agent goes on believing
 * it raised the permissions, and the user is never told it tried. Declared, it
 * reaches the gate, gets refused by name, and shows up in the tool list as
 * something a person sets.
 */
const permissionModeArg = z
  .string()
  .optional()
  .describe('Not settable over MCP. Sending it refuses the call; a person sets it in the manager.');

/** Every tool answers with text — JSON for lists, Markdown for file bodies. */
const reply = (text: string) => ({ content: [{ type: 'text' as const, text }] });

const replyJson = (value: unknown) => reply(JSON.stringify(value, null, 2));

/**
 * A refusal the agent can read and act on, rather than a thrown error.
 * `isError` is what tells the client this is a failed call and not an answer.
 */
const refuse = (reason: string) => ({
  content: [{ type: 'text' as const, text: reason }],
  isError: true
});

/** What every handler returns: an answer, or a refusal the agent can read. */
type Reply = ReturnType<typeof reply> | ReturnType<typeof refuse>;

/**
 * How a tool is declared. `annotations` is typed as plain booleans rather than
 * against the SDK's own type so `READS` and `WRITES` pass through untouched —
 * the shape is forwarded, never read here.
 */
interface ToolSpec<Schema extends StandardSchemaWithJSON> {
  title: string;
  annotations: Readonly<Record<string, boolean>>;
  description: string;
  inputSchema: Schema;
}

/**
 * Registers a tool whose handler cannot fail without saying so.
 *
 * A throw becomes a refusal the agent can read and a line on stderr the user can
 * find, rather than an error that exists only at the far end. `target` is
 * undefined when `--ask-only` withheld the tool, which keeps each registration a
 * single expression instead of an `if` around the lot.
 */
function tool<Schema extends StandardSchemaWithJSON>(
  target: McpServer | undefined,
  name: string,
  spec: ToolSpec<Schema>,
  handler: (args: StandardSchemaWithJSON.InferOutput<Schema>) => Promise<Reply>
): void {
  const guarded = async (args: StandardSchemaWithJSON.InferOutput<Schema>): Promise<Reply> => {
    try {
      return await handler(args);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      note(`${name} failed: ${reason}`);
      return refuse(`${name} could not complete: ${reason}`);
    }
  };

  // The SDK works out a handler's argument type from the schema through a
  // conditional type, which TypeScript cannot evaluate while `Schema` is still
  // a type parameter — the same call typechecks with a concrete schema. The
  // cast is on this one hand-off; `guarded` above is fully typed, and each of
  // the fifteen call sites still gets its arguments from its own `inputSchema`.
  target?.registerTool(name, spec, guarded as never);
}

/**
 * Resolves a plan name, or explains why it will not. Wrapping `planPath`'s throw
 * turns a traversal attempt into an ordinary refused tool call — the agent gets
 * a sentence instead of a stack trace, and the outcome is identical.
 */
function resolvePlan(dir: string, name: string): { filePath: string } | { reason: string } {
  let filePath: string;
  try {
    filePath = library.planPath(dir, name);
  } catch {
    return { reason: `"${name}" is not a plan name. Use the name as list_plans reports it.` };
  }
  if (!fs.existsSync(filePath)) {
    return { reason: `There is no plan called "${name}". Call list_plans to see what there is.` };
  }
  return { filePath };
}

/**
 * Checks a `cwd` argument against the folder this server speaks for, or
 * undefined when the caller did not send one — which is the common case, and
 * means the series keeps the default.
 *
 * The undefined return is what lets both write tools spell the check as one
 * `if`, rather than each repeating "only when it was given" around the call.
 */
function whereToRun(cwd: string | undefined) {
  return cwd === undefined ? undefined : planCwd(cwd, FOLDER);
}

const state = (): ChronosState => readState(paths().state).state;

/** The view of a series an agent gets. `filePath` is included for orientation
 *  only — nothing may be scheduled by path, and no tool accepts one back. */
function describeSeries(series: TaskSeries) {
  return {
    id: series.id,
    plan: series.fileName,
    nextRunAt: series.nextRunAt,
    recurrence: series.recurrence,
    enabled: series.enabled,
    spent: series.spent ?? false,
    // Without this a plan waiting its turn in a chain reads as unscheduled and
    // spent — which is what it looks like from the fields above, and is wrong.
    runsAfter: series.chain
      ? { seriesId: series.chain.after, delayMinutes: series.chain.delayMinutes }
      : undefined,
    engine: series.agent ?? 'claude',
    model: series.model ?? '(account default)',
    permissionMode: series.permissionMode,
    cwd: series.cwd,
    maxRetries: series.maxRetries
  };
}

/** `QUEUED_NOTE` when nothing is watching this folder, otherwise undefined. */
function queuedNote(): string | undefined {
  return schedulerIsLive(readLock(paths().lock)) ? undefined : QUEUED_NOTE;
}

function describeRun(run: TaskRun) {
  return {
    id: run.id,
    seriesId: run.seriesId,
    status: run.status,
    attempt: run.attempt,
    scheduledAt: run.scheduledAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    costUsd: run.costUsd,
    denials: run.denials,
    result: run.result,
    lastError: run.lastError,
    hasTranscript: Boolean(run.resultPath)
  };
}

///////////////////////////*The tool surface*////////////////////////////

const server = new McpServer(
  { name: 'chronos', version: VERSION },
  { capabilities: { tools: {} } }
);

/**
 * Everything except `ask_user` and `submit_plan`, registered through here so
 * `--ask-only` can withhold the lot with one binding rather than an `if` wrapped
 * around three hundred lines.
 *
 * Withheld rather than refused at call time: a tool that is never declared does
 * not appear in the session's tool list at all, so there is nothing for it to
 * try, and nothing for a model to talk itself into.
 */
const fullSurface = ASK_ONLY ? undefined : server;

/**
 * The standard MCP hints, which are what a client reads to decide what it can
 * wave through without asking. Codex's `default_tools_approval_mode = "writes"`,
 * VS Code and Cursor all use them; without them, reading the schedule is treated
 * as warily as rewriting it, and every listing costs the user a prompt.
 *
 * They are hints about intent and change nothing about what this server permits.
 * The `permissionMode` refusal in `mcp-tools.ts` remains the actual boundary.
 *
 * `openWorldHint` is false on all fifteen: this server touches one local folder
 * and never reaches the network.
 */
const READS = { readOnlyHint: true, openWorldHint: false } as const;

/** A write nothing else can be derived from — calling it twice does it twice. */
const WRITES = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
} as const;

// ---------- read ----------

tool(fullSurface,
  'list_plans',
  {
    title: 'List plans',
    annotations: READS,
    description:
      'The Chronos plan library for this project: every Markdown plan that can be scheduled. ' +
      'Newest first. A plan is addressed by its `name` everywhere else in this server.',
    inputSchema: z.object({})
  },
  async () =>
    replyJson(
      library.listPlans(paths().plans).map((plan) => ({
        name: plan.name,
        title: plan.title,
        modified: new Date(plan.modifiedMs).toISOString(),
        sizeBytes: plan.sizeBytes
      }))
    )
);

tool(fullSurface,
  'read_plan',
  {
    title: 'Read a plan',
    annotations: READS,
    description: 'The Markdown body of one plan, by the name list_plans reports.',
    inputSchema: z.object({ name: z.string().describe('Plan file name, e.g. "nightly-audit.md"') })
  },
  async ({ name }) => {
    const dir = paths().plans;
    const found = resolvePlan(dir, name);
    if ('reason' in found) {
      return refuse(found.reason);
    }
    return reply(library.readPlan(dir, name));
  }
);

tool(fullSurface,
  'list_tasks',
  {
    title: 'List captured tasks',
    annotations: READS,
    description:
      'The capture inbox: one-line jobs noted down but not yet written up as a plan. ' +
      'These are what the Chronos sidebar shows.',
    inputSchema: z.object({})
  },
  async () => {
    const dir = paths().tasks;
    return replyJson(
      library.listPlans(dir).map((task) => ({
        name: task.name,
        text: library.taskLabel(safeRead(task.filePath)),
        captured: new Date(task.modifiedMs).toISOString()
      }))
    );
  }
);

tool(fullSurface,
  'list_schedule',
  {
    title: 'List the schedule',
    annotations: READS,
    description:
      'Every scheduled series in this project: which plan it runs, when it runs next, whether ' +
      'it repeats, and what it runs as. Use the `id` for update_schedule and unschedule.',
    inputSchema: z.object({})
  },
  async () => replyJson(state().series.map(describeSeries))
);

tool(fullSurface,
  'list_runs',
  {
    title: 'List runs',
    annotations: READS,
    description:
      'Recent run history — what actually happened when a scheduled task fired, including ' +
      'cost, permission denials and the agent’s closing message.',
    inputSchema: z.object({
      seriesId: z.string().optional().describe('Only runs of this series. Omit for all.'),
      limit: z.number().int().min(1).max(100).optional().describe('Newest first. Default 20.')
    })
  },
  async ({ seriesId, limit }) => {
    const runs = state()
      .runs.filter((run) => !seriesId || run.seriesId === seriesId)
      .sort((a, b) => Date.parse(b.scheduledAt) - Date.parse(a.scheduledAt))
      .slice(0, limit ?? 20);
    return replyJson(runs.map(describeRun));
  }
);

tool(fullSurface,
  'read_transcript',
  {
    title: 'Read a run transcript',
    annotations: READS,
    description:
      'The full Markdown transcript of a finished run: what the agent was asked, what it did, ' +
      'and how it ended. Only finished runs have one.',
    inputSchema: z.object({ runId: z.string().describe('A run id from list_runs') })
  },
  async ({ runId }) => {
    const run = state().runs.find((r) => r.id === runId);
    if (!run) {
      return refuse('No run has that id. Call list_runs for the current ones.');
    }
    if (!run.resultPath) {
      return refuse(`That run (${run.status}) has no transcript.`);
    }
    try {
      return reply(fs.readFileSync(run.resultPath, 'utf8'));
    } catch {
      return refuse(`Its transcript is no longer on disk at ${run.resultPath}.`);
    }
  }
);

// ---------- write ----------

tool(fullSurface,
  'add_task',
  {
    title: 'Capture a task',
    annotations: WRITES,
    description:
      'Notes a one-line job into the Chronos inbox, where it appears in the sidebar of any open ' +
      'VS Code window on this project. Capture only — nothing is scheduled and nothing runs.',
    inputSchema: z.object({ text: z.string().min(1).max(2000).describe('What needs doing') })
  },
  async ({ text }) => {
    const clean = text.trim();
    if (!clean) {
      return refuse('A task needs some text.');
    }
    const task = library.createPlan(ensureWritable().tasks, clean, `${clean}\n`);
    note(`captured task ${task.name}`);
    return reply(`Captured "${task.title}" in the Chronos inbox as ${task.name}.`);
  }
);

tool(fullSurface,
  'add_plan',
  {
    title: 'Write a plan',
    annotations: WRITES,
    description:
      'Writes a Markdown plan into the library. This is what a scheduled run hands the coding ' +
      'agent as its prompt, so write it as instructions. Does not schedule it — call ' +
      'schedule_plan with the name this returns.',
    inputSchema: z.object({
      title: z.string().min(1).max(200).describe('Plain-language title; the file name is derived from it'),
      body: z.string().min(1).max(500_000).describe('The plan itself, as Markdown')
    })
  },
  async ({ title, body }) => {
    const plan = library.createPlan(ensureWritable().plans, title, body);
    note(`wrote plan ${plan.name}`);
    return reply(`Wrote ${plan.name} to the plan library. Schedule it with schedule_plan.`);
  }
);

tool(fullSurface,
  'schedule_plan',
  {
    title: 'Schedule a plan',
    annotations: WRITES,
    description:
      'Puts a plan on the schedule. The open VS Code window fires it at the time given — this ' +
      'does not run anything now. New tasks always run in `auto` permission mode; that cannot ' +
      'be set from here.',
    inputSchema: z.object({
      name: z.string().describe('Plan file name, from list_plans or add_plan'),
      at: z
        .string()
        .optional()
        .describe('ISO 8601 date and time of the first run. Required unless `repeat` is set.'),
      repeat: z
        .enum(['once', 'daily', 'weekly', 'monthly'])
        .optional()
        .describe('Default once'),
      timeLocal: z
        .string()
        .optional()
        .describe('"HH:MM" local time for a repeating rule. Taken from `at` if omitted.'),
      daysOfWeek: z
        .array(z.number().int().min(0).max(6))
        .optional()
        .describe('Weekly rules only. 0 = Sunday .. 6 = Saturday.'),
      dayOfMonth: z
        .number()
        .int()
        .min(1)
        .max(31)
        .optional()
        .describe('Monthly rules only. Defaults to the day `at` falls on.'),
      agent: z.enum(['claude', 'opencode']).optional().describe('Engine. Default claude.'),
      model: z.string().optional().describe('Model id. Omit for the account default.'),
      cwd: z
        .string()
        .optional()
        .describe(
          'Working directory for the run, which must be this project folder or one inside it. ' +
            'Defaults to this project.'
        ),
      maxRetries: z.number().int().min(0).max(10).optional(),
      permissionMode: permissionModeArg
    })
  },
  async (args) => {
    // As in `update_schedule`: nothing is created until the call has survived
    // every check, so a refused call leaves an unconfigured folder untouched.
    const resolved = paths();
    const found = resolvePlan(resolved.plans, args.name);
    if ('reason' in found) {
      return refuse(found.reason);
    }

    const where = whereToRun(args.cwd);
    if (where && !where.ok) {
      return refuse(where.reason);
    }

    const timing = planTiming(args as ScheduleWhen);
    if (!timing.ok) {
      return refuse(timing.reason);
    }

    // Only the fields an agent may set are forwarded, so a stray argument is
    // never silently written; `planSeriesOverrides` refuses anything else.
    // `cwd` comes from `whereToRun` rather than from `pick`, so the value that
    // is stored is the contained, resolved one.
    const overrides = planSeriesOverrides({
      ...pick(args, ['agent', 'model', 'maxRetries', 'permissionMode']),
      ...(where?.ok ? { cwd: where.value } : {}),
      ...timing.value
    });
    if (!overrides.ok) {
      return refuse(overrides.reason);
    }

    const series = createSeries(
      found.filePath,
      { cwd: resolved.folder, maxRetries: DEFAULT_MAX_RETRIES },
      overrides.value
    );
    updateState(ensureWritable().state, (current) => {
      current.series.push(series);
    });

    note(`scheduled ${series.fileName} for ${series.nextRunAt}`);
    // A second field rather than one merged sentence, so an agent reading the
    // JSON can tell "this is what it will run as" from "this is when, if ever".
    const queued = queuedNote();
    return replyJson({
      scheduled: series.fileName,
      ...describeSeries(series),
      note: 'It runs in `auto` permission mode. Raise that in the Chronos manager if it needs more.',
      ...(queued ? { queued } : {})
    });
  }
);

tool(fullSurface,
  'update_schedule',
  {
    title: 'Change a schedule',
    // Idempotent: it sets fields to the values given, so repeating the same call
    // leaves the same series in the same state.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    description:
      'Reschedules, re-repeats, pauses or resumes an existing series. Permission mode cannot be ' +
      'changed from here.',
    inputSchema: z.object({
      id: z.string().describe('Series id, from list_schedule'),
      at: z.string().optional().describe('ISO 8601 date and time to move the next run to'),
      repeat: z.enum(['once', 'daily', 'weekly', 'monthly']).optional(),
      timeLocal: z.string().optional().describe('"HH:MM" local time for a repeating rule'),
      daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
      dayOfMonth: z.number().int().min(1).max(31).optional(),
      enabled: z.boolean().optional().describe('False pauses the series, including queued retries'),
      agent: z.enum(['claude', 'opencode']).optional(),
      model: z.string().optional(),
      cwd: z
        .string()
        .optional()
        .describe('Must be this project folder or one inside it.'),
      maxRetries: z.number().int().min(0).max(10).optional(),
      permissionMode: permissionModeArg
    })
  },
  async (args) => {
    // Read and validate before `ensureWritable`, so a call that is going to be
    // refused does not leave a `.chronos` tree behind in an unconfigured folder.
    const series = state().series.find((s) => s.id === args.id);

    const where = whereToRun(args.cwd);
    if (where && !where.ok) {
      return refuse(where.reason);
    }

    const patch: Record<string, unknown> = {
      ...pick(args, ['enabled', 'agent', 'model', 'maxRetries', 'permissionMode']),
      ...(where?.ok ? { cwd: where.value } : {})
    };

    // Timing is only recomputed when the caller said something about it —
    // otherwise pausing a task would silently move when it next runs. The same
    // test decides whether the reply mentions the queue: pausing or renaming a
    // series says nothing about when it will run, so it carries no note.
    const retimed = args.at !== undefined || args.repeat !== undefined || args.timeLocal !== undefined;
    if (retimed) {
      const timing = planTiming(args as ScheduleWhen);
      if (!timing.ok) {
        return refuse(timing.reason);
      }
      Object.assign(patch, timing.value);
      // A one-shot that already fired stays spent unless it is given a new time,
      // which is the one thing that makes it due again.
      patch.spent = false;
    }

    const verdict = planSeriesUpdate(patch, series);
    if (!verdict.ok) {
      return refuse(verdict.reason);
    }

    // A chain link is the one field an agent can set that says something about
    // another task, so it is the one that can be self-defeating: a link onto a
    // task that is not there, or into a loop, parks both ends forever waiting
    // for a run that never comes.
    if (verdict.value.chain) {
      const scheduled = state().series;
      const after = verdict.value.chain.after;
      if (!scheduled.some((s) => s.id === after)) {
        return refuse('No scheduled task has that id, so nothing can run after it.');
      }
      if (wouldCycle(scheduled, args.id, after)) {
        return refuse('That would make a loop — the two tasks would each be waiting on the other.');
      }
    }

    let updated: TaskSeries | undefined;
    updateState(ensureWritable().state, (current) => {
      const target = current.series.find((s) => s.id === args.id);
      if (target) {
        // The same stamp the extension's store applies, for the same reason: a
        // repeat rule dropped from here has to be dated too, or the window's
        // next sweep archives the plan before its one-shot occurrence fires.
        Object.assign(target, stampRepeatEnd(target, verdict.value));
        updated = target;
      }
    });

    if (!updated) {
      return refuse('That task was removed while this call was in flight.');
    }
    note(`updated series ${updated.id}`);
    const queued = retimed ? queuedNote() : undefined;
    return replyJson({ ...describeSeries(updated), ...(queued ? { queued } : {}) });
  }
);

tool(fullSurface,
  'unschedule',
  {
    title: 'Unschedule a task',
    // The only tool here that destroys anything: it drops the series *and* its
    // run history, and nothing brings either back.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    },
    description:
      'Removes a series from the schedule, together with its run history. The plan file itself ' +
      'is untouched and can be scheduled again. To stop a task without losing its history, call ' +
      'update_schedule with enabled: false.',
    inputSchema: z.object({ id: z.string().describe('Series id, from list_schedule') })
  },
  async ({ id }) => {
    const series = state().series.find((s) => s.id === id);
    if (!series) {
      return refuse('No scheduled task has that id. Call list_schedule for the current ids.');
    }

    updateState(ensureWritable().state, (current) => {
      current.series = current.series.filter((s) => s.id !== id);
      current.runs = current.runs.filter((r) => r.seriesId !== id);
    });

    note(`unscheduled ${series.fileName}`);
    return reply(`Unscheduled ${series.fileName}. Its plan is still in the library.`);
  }
);

// ---------- asking the user ----------

/**
 * How often the waiting session looks for an answer. A second is imperceptible
 * to somebody typing on a phone and costs one small read of one small file.
 */
const POLL_MS = 1000;

/** Long enough to be worth waiting through; short enough to fit inside a
 *  client's own tool timeout, which is what the resume path is for. */
const DEFAULT_WAIT_SECONDS = 240;
const MIN_WAIT_SECONDS = 5;
const MAX_WAIT_SECONDS = 600;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until the question is answered or the wait lapses.
 *
 * Returns the answered file, or undefined for both "not yet" and "no longer
 * there" — the caller says the same thing to either, because the recovery is
 * the same: call again with the id, and be told plainly if it has gone.
 */
async function waitForAnswers(
  dir: string,
  id: string,
  waitSeconds: number
): Promise<QuestionFile | undefined> {
  const deadline = Date.now() + waitSeconds * 1000;

  for (;;) {
    const file = readQuestion(dir, id);
    if (!file) {
      return undefined; // Swept, or deleted by hand. Nothing will answer it now.
    }
    if (file.answeredAt) {
      return file;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await sleep(POLL_MS);
  }
}

tool(server,
  'ask_user',
  {
    title: 'Ask the user a question',
    annotations: WRITES,
    description:
      'Puts a question to the user and waits for the answer. Use this when nobody is at the ' +
      'terminal you are running in — the question is written into this project so it can be ' +
      'answered from another device. Blocks until it is answered or the wait runs out; if it ' +
      'runs out, call again with the `id` you get back to keep waiting. If your client cuts ' +
      'tool calls off sooner than this waits, pass a smaller `waitSeconds` and call again.',
    inputSchema: z.object({
      summary: z
        .string()
        .optional()
        .describe('One or two sentences on what this is about. Required unless resuming an `id`.'),
      questions: z
        .array(
          z.object({
            question: z.string().describe('The question, in plain language'),
            options: z.array(z.string()).optional().describe('Suggested replies, if you have a shortlist')
          })
        )
        .optional()
        .describe('One to ten questions. Required unless resuming an `id`.'),
      waitSeconds: z
        .number()
        .optional()
        .describe(`How long to wait. Default ${DEFAULT_WAIT_SECONDS}, allowed 5 to 600.`),
      id: z
        .string()
        .optional()
        .describe('Resume waiting on a question already asked. Omit to ask a new one.')
    })
  },
  async ({ summary, questions, waitSeconds, id }) => {
    const dir = ensureWritable().questions;

    const wait = Math.min(
      MAX_WAIT_SECONDS,
      Math.max(MIN_WAIT_SECONDS, Math.round(waitSeconds ?? DEFAULT_WAIT_SECONDS))
    );

    let questionId: string;
    if (id) {
      const existing = readQuestion(dir, id);
      if (!existing) {
        return refuse(
          `There is no open question with the id ${id}. Ask a new one, or ask in the terminal.`
        );
      }
      if (existing.answeredAt) {
        return replyJson({ id, answers: existing.answers ?? [] });
      }
      questionId = id;
    } else {
      const planned = planQuestion({ summary, questions });
      if (!planned.ok) {
        return refuse(planned.reason);
      }
      questionId = newQuestionId();
      writeQuestion(dir, {
        id: questionId,
        askedAt: new Date().toISOString(),
        // From the spawn arguments, never from the caller: the label on a
        // question has to be the task it really came from.
        ...(SOURCE ? { source: SOURCE } : {}),
        summary: planned.value.summary,
        questions: planned.value.questions
      });
      note(`asked question ${questionId}`);
    }

    const answered = await waitForAnswers(dir, questionId, wait);
    if (answered) {
      note(`question ${questionId} was answered`);
      return replyJson({ id: questionId, answers: answered.answers ?? [] });
    }

    return reply(
      `No answer yet after ${wait} seconds. The question id is ${questionId}. Call ask_user ` +
        `again with id: "${questionId}" to keep waiting. If your client times a tool call out ` +
        'before the wait ends, pass a smaller `waitSeconds` as well. If that keeps happening, ' +
        'ask in the terminal instead.'
    );
  }
);

tool(fullSurface,
  'list_questions',
  {
    title: 'List questions waiting for an answer',
    annotations: READS,
    description:
      'Questions a Chronos planning session has asked and is still waiting on, newest first. ' +
      'Answer one with answer_question.',
    inputSchema: z.object({
      includeAnswered: z
        .boolean()
        .optional()
        .describe('Include questions already answered. Default false.')
    })
  },
  async ({ includeAnswered }) =>
    replyJson(
      listQuestions(paths().questions)
        .filter((file) => includeAnswered || !file.answeredAt)
        .map((file) => ({
          id: file.id,
          askedAt: file.askedAt,
          source: file.source,
          summary: file.summary,
          questions: file.questions,
          answeredAt: file.answeredAt,
          answers: file.answers
        }))
    )
);

tool(fullSurface,
  'answer_question',
  {
    title: 'Answer a question',
    annotations: WRITES,
    description:
      'Records the answers to a question from list_questions, which is what unblocks the ' +
      'planning session waiting on it. Every question in the set must be answered in one ' +
      'call, and a question can only be answered once.',
    inputSchema: z.object({
      id: z.string().describe('Question id, from list_questions'),
      answers: z
        .array(
          z.object({
            id: z.string().describe('Which question this answers, e.g. "q1"'),
            answer: z.string().describe('The answer, in plain language')
          })
        )
        .describe('One answer for each question that was asked')
    })
  },
  async ({ id, answers }) => {
    const dir = paths().questions;

    const file = readQuestion(dir, id);
    if (!file) {
      return refuse(`There is no question with the id ${id}. Call list_questions for the open ones.`);
    }
    if (file.answeredAt) {
      return refuse(`That question was already answered at ${file.answeredAt}.`);
    }

    const checked = planAnswers(file, answers);
    if (!checked.ok) {
      return refuse(checked.reason);
    }

    // Re-read inside `recordAnswers`, so a question answered between the check
    // above and here is refused rather than quietly overwritten.
    const recorded = recordAnswers(ensureWritable().questions, id, checked.value);
    if (!recorded.ok) {
      return refuse(recorded.reason);
    }

    note(`answered question ${id}`);
    return reply(`Answered. The session waiting on ${id} will pick this up within a second or two.`);
  }
);

if (PENDING) {
  const destination = PENDING;

  tool(server,
    'submit_plan',
    {
      title: 'Submit the finished plan',
      annotations: WRITES,
      description:
        'Delivers the finished plan to Chronos, which files it in this project’s plan library ' +
        'and clears the task it came from. Call this instead of writing the plan to a file ' +
        'yourself. Does not schedule it — a person does that.',
      inputSchema: z.object({
        title: z
          .string()
          .min(1)
          .max(200)
          .describe(
            'Three word description of the outcome the plan produces, e.g. "add monthly repeat"; ' +
              'the file name comes from it'
          ),
        body: z.string().min(1).max(500_000).describe('The plan itself, as Markdown')
      })
    },
    async ({ title, body }) => {
      // Into the folder given at spawn, never a path off the wire, and through
      // the same `createPlan` the library uses — so the slug, the collision
      // suffix and the extension are the ones the watcher is already expecting.
      const plan = library.createPlan(destination, title, body);
      note(`submitted plan ${plan.name}`);
      return reply(
        `Delivered ${plan.name}. Chronos is filing it in the plan library now, and the task ` +
          'it came from is done. Nothing else is needed.'
      );
    }
  );
}

///////////////////////////*Helpers*////////////////////////////

/** Copies across only the keys that were actually given, so an omitted argument
 *  stays omitted rather than becoming an explicit `undefined` in a patch. */
function pick<T extends object>(source: T, keys: readonly (keyof T)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      out[key as string] = source[key];
    }
  }
  return out;
}

/** A task file that vanished mid-listing is worth an empty row, not a failure. */
function safeRead(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

///////////////////////////*Serve*////////////////////////////

note(`serving ${FOLDER}`);

/**
 * A process that dies without a word looks identical to one the client never
 * started. Exit rather than limp on: the client can respawn a dead server, and
 * cannot do anything with one that has stopped answering.
 */
process.on('uncaughtException', (err) => {
  note(`fatal: ${err.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (cause) => {
  note(`unhandled rejection: ${cause instanceof Error ? cause.message : String(cause)}`);
});

serveStdio(() => server, {
  onerror: (err) => note(`transport error: ${err.message}`)
});

import { createMcpHandler, McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { randomBytes, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { Readable } from 'stream';
import { z } from 'zod';
import { buildActivity } from './activity';
import {
  commandStatus,
  ControlOutcome,
  readOutcome as readControlOutcome,
  writeCommand
} from './control';
import { DashboardInstance, instancesDir, STALE_MS } from './dashboard-payload';
import * as library from './library';
import {
  appendToChainAction,
  archivePlanAction,
  captureTask,
  ChainPlansArgs,
  chainPlansAction,
  createPlanAction,
  deleteTaskAction,
  describeRun,
  describeSeries,
  dismissRun,
  editSeries,
  editTaskAction,
  ensureWritable,
  removeSeries,
  renamePlanAction,
  requestPlan,
  rerunRun,
  runSeriesNow,
  runTaskAction,
  savePlanAction,
  ScheduleArgs,
  scheduleSeries,
  summarizeInstance
} from './mcp-actions';
import { planAnswers } from './mcp-tools';
import { listQuestions, readQuestion, recordAnswers } from './questions';
import { readOutcome as readRequestOutcome, requestStatus } from './requests';
import { dashboardDirFor, hasRoot, migrateHomeDir, migrateRoot } from './migrate-name';
import { SynchronyPaths, pathsFor } from './roots';
import { readState } from './state-file';
import { MAX_CHAIN_DELAY_MINUTES } from './types';

/**
 * The Synchrony hub: one MCP server, over HTTP, for every project on this machine.
 *
 * `mcp-server.ts` is the door an agent uses — spawned per project, stdio, no
 * network. This is the door the *owner* uses from somewhere else: a phone, a
 * published board, another machine. It speaks Streamable HTTP so a remote MCP
 * client (a claude.ai connector, for one) can reach it through a tunnel, and it
 * takes an `instance` argument on every tool because there is one of it and
 * many projects.
 *
 * It holds no state of its own. Every call re-reads the folder it names and
 * writes back through the same `mcp-actions.ts` the stdio server uses, so a
 * window on that folder notices exactly as it would for any other writer.
 *
 * //Steps to completion:
 *
 *   //Read the roots to scan and the token to require from argv / env;
 *   //Discover instances: every immediate child of a root with a `.synchrony`;
 *   //Register the read tools, each scoped by `instance`;
 *   //Register the write tools, each going through mcp-actions.ts;
 *   //Bridge Node's http server to the SDK's fetch-shaped handler and listen.
 *
 * Security posture, stated once:
 *
 * - **Token or nothing.** Every MCP request must carry the token, either as
 *   `Authorization: Bearer …` or as the first path segment
 *   (`/<token>/mcp`). The second form exists because claude.ai's custom
 *   connectors speak OAuth or nothing — there is no field for a static
 *   bearer token — so the URL itself is the credential a connector holds.
 *   The compare is constant-time either way; a request with neither gets a
 *   plain 404, not a 401 challenge, so an OAuth-capable client is never
 *   tempted into a discovery dance this server does not offer. `/healthz` is
 *   the one open path and says only that the process is up.
 * - **Loopback by default.** It binds 127.0.0.1. Anything reaching it from
 *   outside comes through a tunnel the owner set up, and the tunnel is where
 *   TLS lives. `--host 0.0.0.0` is available and is a decision, not a default.
 * - **Instances are discovered, never named by path.** A caller says
 *   `Caldera`; the hub decides what folder that is. No tool accepts a path.
 * - **The owner may set permissionMode.** The stdio server refuses it because
 *   an agent must not raise its own permissions. The token here belongs to a
 *   person, so `scheduleSeries` is called with `allowPermissionMode: true`.
 */

///////////////////////////*Process setup*////////////////////////////

const VERSION = process.env.SYNCHRONY_VERSION ?? '0.0.0-dev';
const DEFAULT_PORT = 7433;
const DEFAULT_MAX_RETRIES = 3;
// Renamed from `.chronos-dashboard` if that is what this machine has; the token
// and every heartbeat move with it.
migrateHomeDir();
const HUB_DIR = dashboardDirFor();
const DEFAULT_TOKEN_FILE = path.join(HUB_DIR, 'hub.token');

function note(text: string): void {
  process.stderr.write(`[synchrony-hub] ${text}\n`);
}

/** Every value after each occurrence of `flag`. */
function argValues(argv: readonly string[], flag: string): string[] {
  const out: string[] = [];
  argv.forEach((arg, i) => {
    const next = argv[i + 1];
    if (arg === flag && next && !next.startsWith('--')) {
      out.push(next);
    }
  });
  return out;
}

const ARGV = process.argv.slice(2);
const ROOTS = argValues(ARGV, '--root').map((r) => path.resolve(r));
const FOLDERS = argValues(ARGV, '--folder').map((f) => path.resolve(f));
const PORT = Number(argValues(ARGV, '--port')[0] ?? process.env.SYNCHRONY_HUB_PORT ?? DEFAULT_PORT);
const HOST = argValues(ARGV, '--host')[0] ?? process.env.SYNCHRONY_HUB_HOST ?? '127.0.0.1';
const TOKEN_FILE = argValues(ARGV, '--token-file')[0] ?? DEFAULT_TOKEN_FILE;

if (!ROOTS.length && !FOLDERS.length) {
  note('nothing to serve: pass --root <dir-of-projects> and/or --folder <project> (repeatable)');
  process.exit(2);
}

/**
 * The token: from the environment, else from the token file, else minted and
 * written there once. Printed to stderr only when minted, so a restart says
 * nothing and the secret is on screen exactly once.
 */
function loadToken(): string {
  const fromEnv = process.env.SYNCHRONY_HUB_TOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const onDisk = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (onDisk) {
      return onDisk;
    }
  } catch {
    // Not there yet.
  }
  const minted = randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, `${minted}\n`, { encoding: 'utf8', mode: 0o600 });
  note(`minted a new token and wrote it to ${TOKEN_FILE}`);
  note(`token: ${minted}`);
  return minted;
}

const TOKEN = loadToken();
const TOKEN_BYTES = Buffer.from(TOKEN, 'utf8');

function sameSecret(given: string): boolean {
  const g = Buffer.from(given, 'utf8');
  return g.length === TOKEN_BYTES.length && timingSafeEqual(g, TOKEN_BYTES);
}

function headerMatches(header: string | undefined): boolean {
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return Boolean(m) && sameSecret(m![1]);
}

/**
 * The token as a leading path segment: `/<token>` or `/<token>/anything`.
 * Returns the path with the segment removed when it matches, else undefined.
 * Decoded first, so a client that percent-encodes the segment still matches.
 */
function pathWithoutToken(pathname: string): string | undefined {
  const [, first = '', ...rest] = pathname.split('/');
  let decoded: string;
  try {
    decoded = decodeURIComponent(first);
  } catch {
    return undefined;
  }
  if (!decoded || !sameSecret(decoded)) return undefined;
  return '/' + rest.join('/');
}

///////////////////////////*Instances*////////////////////////////

interface Instance {
  name: string;
  paths: SynchronyPaths;
}

/**
 * Every project this hub speaks for, re-read on each call so a folder created
 * after start-up appears without a restart. A project is a folder with a
 * `.synchrony` directory in it; the folder's own name is the instance name.
 */
function discover(): Instance[] {
  const seen = new Map<string, Instance>();
  const add = (folder: string) => {
    if (!hasRoot(folder)) return;
    // A project still on `.chronos` is renamed the first time the hub sees it.
    // `failed` (a handle held by an older window) is served under the old name.
    if (migrateRoot(folder) === 'migrated') note(`migrated ${folder}: .chronos -> .synchrony`);
    const name = path.basename(folder);
    if (!seen.has(name.toLowerCase())) {
      seen.set(name.toLowerCase(), { name, paths: pathsFor(folder) });
    }
  };
  for (const root of ROOTS) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      note(`cannot read root ${root}: ${String(err)}`);
    }
    for (const e of entries) {
      if (e.isDirectory()) add(path.join(root, e.name));
    }
  }
  FOLDERS.forEach(add);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function findInstance(name: string): Instance | undefined {
  const want = name.trim().toLowerCase();
  return discover().find((i) => i.name.toLowerCase() === want);
}

///////////////////////////*Live windows*////////////////////////////

interface LiveWindows {
  settings: DashboardInstance['settings'] | null;
  availableAgents: string[] | null;
  windows: { status: DashboardInstance['status']; leader: boolean; heartbeatAt: string }[];
}

/**
 * What a live editor window on `folder` is telling the dashboard about itself,
 * read straight from its heartbeat file. Several windows can watch the same
 * folder, so `settings`/`availableAgents` come from whichever of them leads the
 * scheduler (or, absent a leader, the first one found) while `windows` lists
 * every matching heartbeat. No match at all means nothing here can answer for
 * this folder — settings and agents are null, not a stale guess.
 */
function liveWindows(folder: string, now: number = Date.now()): LiveWindows {
  const dir = instancesDir();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { settings: null, availableAgents: null, windows: [] };
  }

  const matches: DashboardInstance[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as DashboardInstance;
      if (now - Date.parse(parsed.lastHeartbeatAt) > STALE_MS) continue;
      if (!library.samePath(parsed.activeFolder, folder)) continue;
      matches.push(parsed);
    } catch {
      // A heartbeat mid-write is not worth failing the call for.
    }
  }

  if (!matches.length) {
    return { settings: null, availableAgents: null, windows: [] };
  }

  const primary = matches.find((m) => m.schedulerLeader) ?? matches[0];
  return {
    settings: primary.settings ?? null,
    availableAgents: primary.availableAgents ?? null,
    windows: matches.map((m) => ({ status: m.status, leader: m.schedulerLeader, heartbeatAt: m.lastHeartbeatAt }))
  };
}

///////////////////////////*Replies*////////////////////////////

const reply = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const replyJson = (value: unknown) => reply(JSON.stringify(value, null, 2));
const refuse = (reason: string) => ({ content: [{ type: 'text' as const, text: reason }], isError: true });
type Reply = ReturnType<typeof reply> | ReturnType<typeof refuse>;

const READS = { readOnlyHint: true, openWorldHint: false } as const;
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const instanceArg = z.string().min(1).describe('Instance name, from list_instances (the project folder name)');

interface ToolSpec<Schema extends StandardSchemaWithJSON> {
  title: string;
  annotations: Readonly<Record<string, boolean>>;
  description: string;
  inputSchema: Schema;
}

/** Registers a tool whose handler cannot fail without saying so. */
function tool<Schema extends StandardSchemaWithJSON>(
  server: McpServer,
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
  server.registerTool(name, spec, guarded as never);
}

/** Resolves `instance` or produces the refusal — every scoped tool starts here. */
function scoped<A extends { instance: string }, R>(
  args: A,
  run: (inst: Instance, args: A) => R
): R | ReturnType<typeof refuse> {
  const inst = findInstance(args.instance);
  if (!inst) {
    const known = discover().map((i) => i.name);
    return refuse(`No instance named "${args.instance}". Known: ${known.join(', ') || '(none)'}.`);
  }
  return run(inst, args);
}

///////////////////////////*The tool surface*////////////////////////////

function buildServer(): McpServer {
  const server = new McpServer({ name: 'synchrony-hub', version: VERSION }, { capabilities: { tools: {} } });

  // ---------- read ----------

  tool(server, 'list_instances', {
    title: 'List Synchrony instances',
    annotations: READS,
    description:
      'Every project this hub speaks for, with whether a VS Code window is live on it, what is ' +
      'running, what runs next, and how many series sit in each state.',
    inputSchema: z.object({})
  }, async () =>
    replyJson({
      capturedAt: new Date().toISOString(),
      instances: discover().map((i) => ({ instance: i.name, ...summarizeInstance(i.paths) }))
    })
  );

  tool(server, 'list_tasks', {
    title: 'List inbox tasks',
    annotations: READS,
    description: 'The capture inbox of one instance: jobs noted down but not yet planned.',
    inputSchema: z.object({ instance: instanceArg })
  }, async (args) =>
    scoped(args, (inst) =>
      replyJson(
        library.listPlans(inst.paths.tasks).map((file) => ({
          name: file.name,
          text: safeRead(file.filePath).trim(),
          captured: new Date(file.modifiedMs).toISOString()
        }))
      )
    )
  );

  tool(server, 'list_plans', {
    title: 'List plans',
    annotations: READS,
    description: 'The plan library of one instance: every Markdown plan that can be scheduled.',
    inputSchema: z.object({ instance: instanceArg })
  }, async (args) =>
    scoped(args, (inst) =>
      replyJson(
        library.listPlans(inst.paths.plans).map((file) => ({
          name: file.name,
          title: file.title,
          modified: new Date(file.modifiedMs).toISOString(),
          sizeBytes: file.sizeBytes
        }))
      )
    )
  );

  tool(server, 'read_plan', {
    title: 'Read a plan',
    annotations: READS,
    description: 'The Markdown body of one plan.',
    inputSchema: z.object({ instance: instanceArg, name: z.string() })
  }, async (args) =>
    scoped(args, (inst) => {
      try {
        return reply(library.readPlan(inst.paths.plans, args.name));
      } catch {
        return refuse(`There is no plan named "${args.name}" in ${inst.name}.`);
      }
    })
  );

  tool(server, 'list_schedule', {
    title: 'List the schedule',
    annotations: READS,
    description: 'Every series in one instance: which plan, when next, whether it repeats, engine and model.',
    inputSchema: z.object({ instance: instanceArg })
  }, async (args) =>
    scoped(args, (inst) => replyJson(readState(inst.paths.state).state.series.map(describeSeries)))
  );

  tool(server, 'list_runs', {
    title: 'List recent runs',
    annotations: READS,
    description: 'Run history for one instance, newest first.',
    inputSchema: z.object({
      instance: instanceArg,
      limit: z.number().int().min(1).max(100).optional().describe('Default 20')
    })
  }, async (args) =>
    scoped(args, (inst) =>
      replyJson(
        readState(inst.paths.state)
          .state.runs.slice()
          .sort((a, b) => Date.parse(b.scheduledAt) - Date.parse(a.scheduledAt))
          .slice(0, args.limit ?? 20)
          .map(describeRun)
      )
    )
  );

  tool(server, 'list_questions', {
    title: 'List questions waiting for an answer',
    annotations: READS,
    description: 'Questions a planning session in one instance has asked and is still waiting on.',
    inputSchema: z.object({ instance: instanceArg, includeAnswered: z.boolean().optional() })
  }, async (args) =>
    scoped(args, (inst) =>
      replyJson(
        listQuestions(inst.paths.questions)
          .filter((f) => args.includeAnswered || !f.answeredAt)
          .map((f) => ({
            id: f.id,
            askedAt: f.askedAt,
            source: f.source,
            summary: f.summary,
            questions: f.questions,
            answeredAt: f.answeredAt,
            answers: f.answers
          }))
      )
    )
  );

  tool(server, 'read_instance', {
    title: 'Read everything about one instance',
    annotations: READS,
    description:
      'The one call a phone needs to poll: plans, schedule, recent runs, tasks, unanswered ' +
      'questions, the upcoming/recent activity feed, and — when a live editor window is open on ' +
      'this folder — its Settings page and the agents it found reachable. Everything the Manager ' +
      'and Tasks panels show, in one JSON document.',
    inputSchema: z.object({ instance: instanceArg })
  }, async (args) =>
    scoped(args, (inst) => {
      const now = Date.now();
      const { state } = readState(inst.paths.state);
      const windows = liveWindows(inst.paths.folder, now);
      return replyJson({
        capturedAt: new Date(now).toISOString(),
        instance: inst.name,
        ...summarizeInstance(inst.paths, now),
        plans: library.listPlans(inst.paths.plans).map((file) => ({
          name: file.name,
          title: file.title,
          modified: new Date(file.modifiedMs).toISOString(),
          sizeBytes: file.sizeBytes
        })),
        series: state.series.map(describeSeries),
        runs: state.runs
          .slice()
          .sort((a, b) => Date.parse(b.scheduledAt) - Date.parse(a.scheduledAt))
          .slice(0, 50)
          .map(describeRun),
        tasks: library.listPlans(inst.paths.tasks).map((file) => ({
          name: file.name,
          text: safeRead(file.filePath).trim(),
          captured: new Date(file.modifiedMs).toISOString()
        })),
        questions: listQuestions(inst.paths.questions)
          .filter((f) => !f.answeredAt)
          .map((f) => ({
            id: f.id,
            askedAt: f.askedAt,
            source: f.source,
            summary: f.summary,
            questions: f.questions,
            answeredAt: f.answeredAt,
            answers: f.answers
          })),
        activity: buildActivity(state.series, state.runs, now),
        settings: windows.settings,
        availableAgents: windows.availableAgents,
        windows: windows.windows
      });
    })
  );

  tool(server, 'read_transcript', {
    title: 'Read a run transcript',
    annotations: READS,
    description:
      'The full Markdown transcript of a finished run: what the agent was asked, what it did, ' +
      'and how it ended. Only finished runs have one.',
    inputSchema: z.object({ instance: instanceArg, runId: z.string().describe('A run id from list_runs') })
  }, async (args) =>
    scoped(args, (inst) => {
      const { state } = readState(inst.paths.state);
      const run = state.runs.find((r) => r.id === args.runId);
      if (!run) return refuse(`No run has that id in ${inst.name}. Call list_runs for the current ones.`);
      if (!run.resultPath) return refuse(`That run (${run.status}) has no transcript.`);
      try {
        return reply(fs.readFileSync(run.resultPath, 'utf8'));
      } catch {
        return refuse(`Its transcript is no longer on disk at ${run.resultPath}.`);
      }
    })
  );

  tool(server, 'read_log', {
    title: 'Read a run’s raw log',
    annotations: READS,
    description:
      'The raw output of a run, before it was turned into a transcript — what a transcript-less ' +
      'run (still running, or one that failed before producing one) has instead.',
    inputSchema: z.object({ instance: instanceArg, runId: z.string().describe('A run id from list_runs') })
  }, async (args) =>
    scoped(args, (inst) => {
      const { state } = readState(inst.paths.state);
      const run = state.runs.find((r) => r.id === args.runId);
      if (!run) return refuse(`No run has that id in ${inst.name}. Call list_runs for the current ones.`);
      if (!run.logPath) return refuse(`That run (${run.status}) has no log.`);
      try {
        return reply(fs.readFileSync(run.logPath, 'utf8'));
      } catch {
        return refuse(`Its log is no longer on disk at ${run.logPath}.`);
      }
    })
  );

  tool(server, 'request_status', {
    title: 'Check a plan-generation request',
    annotations: READS,
    description:
      'Where a request_plan call stands: queued, claimed by a window opening the planning ' +
      'session, or done, with the outcome once it is.',
    inputSchema: z.object({ instance: instanceArg, id: z.string().describe('A request id from request_plan') })
  }, async (args) =>
    scoped(args, (inst) => {
      const status = requestStatus(inst.paths.requests, args.id);
      const done = status === 'done' ? readRequestOutcome(inst.paths.requests, args.id) : undefined;
      return replyJson({ instance: inst.name, id: args.id, status, outcome: done?.outcome });
    })
  );

  // ---------- write ----------

  tool(server, 'add_task', {
    title: 'Capture a task',
    annotations: WRITES,
    description: 'Notes a one-line job into one instance’s inbox. Capture only — nothing runs.',
    inputSchema: z.object({ instance: instanceArg, text: z.string().min(1).max(2000) })
  }, async (args) =>
    scoped(args, (inst) => {
      const out = captureTask(inst.paths, args.text);
      if (!out.ok) return refuse(out.reason);
      note(`${inst.name}: captured task ${out.value.name}`);
      return replyJson({ instance: inst.name, captured: out.value.name, title: out.value.title });
    })
  );

  tool(server, 'request_plan', {
    title: 'Generate a plan from a task',
    annotations: WRITES,
    description:
      'Asks a live VS Code window on that instance to open a planning session for an inbox task. ' +
      'The session asks its questions through Synchrony (see list_questions / answer_question) and ' +
      'lands the plan in the library. Nothing is scheduled.',
    inputSchema: z.object({
      instance: instanceArg,
      task: z.string().describe('Task file name, from list_tasks'),
      series: z.boolean().optional().describe('Split the work into a chain of stage plans'),
      model: z.string().optional().describe('Model id for the planning session. Omit for the window’s default.')
    })
  }, async (args) =>
    scoped(args, (inst) => {
      const out = requestPlan(inst.paths, {
        task: args.task,
        series: args.series,
        model: args.model,
        source: 'hub'
      });
      if (!out.ok) return refuse(out.reason);
      note(`${inst.name}: plan requested for ${args.task} (${out.value.request.id})`);
      return replyJson({ instance: inst.name, requestId: out.value.request.id, live: out.value.live, note: out.value.note });
    })
  );

  tool(server, 'schedule_plan', {
    title: 'Schedule a plan',
    annotations: WRITES,
    description:
      'Puts a plan on one instance’s schedule. The window on that folder fires it at the time given.',
    inputSchema: z.object({
      instance: instanceArg,
      name: z.string().describe('Plan file name, from list_plans'),
      at: z.string().optional().describe('ISO 8601 first run. Required unless repeat is set.'),
      repeat: z.enum(['once', 'daily', 'weekly', 'monthly']).optional(),
      timeLocal: z.string().optional().describe('"HH:MM" local, for repeating rules'),
      daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
      dayOfMonth: z.number().int().min(1).max(31).optional(),
      agent: z.enum(['claude', 'opencode', 'codex']).optional(),
      model: z.string().optional(),
      permissionMode: z.enum(['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'manual', 'plan']).optional(),
      maxRetries: z.number().int().min(0).max(10).optional()
    })
  }, async (args) =>
    scoped(args, (inst) => {
      const { instance: _instance, ...rest } = args;
      const out = scheduleSeries(inst.paths, rest as ScheduleArgs, {
        maxRetries: DEFAULT_MAX_RETRIES,
        allowPermissionMode: true
      });
      if (!out.ok) return refuse(out.reason);
      note(`${inst.name}: scheduled ${out.value.series.fileName} for ${out.value.series.nextRunAt}`);
      return replyJson({
        instance: inst.name,
        scheduled: out.value.series.fileName,
        ...describeSeries(out.value.series),
        ...(out.value.queued ? { queued: out.value.queued } : {})
      });
    })
  );

  tool(server, 'answer_question', {
    title: 'Answer a question',
    annotations: WRITES,
    description: 'Records the answers to a question from list_questions, which unblocks the planning session waiting on it.',
    inputSchema: z.object({
      instance: instanceArg,
      id: z.string(),
      answers: z.array(z.object({ id: z.string(), answer: z.string() }))
    })
  }, async (args) =>
    scoped(args, (inst) => {
      const file = readQuestion(inst.paths.questions, args.id);
      if (!file) return refuse(`There is no question with the id ${args.id} in ${inst.name}.`);
      if (file.answeredAt) return refuse(`That question was already answered at ${file.answeredAt}.`);
      const checked = planAnswers(file, args.answers);
      if (!checked.ok) return refuse(checked.reason);
      const recorded = recordAnswers(inst.paths.questions, args.id, checked.value);
      if (!recorded.ok) return refuse(recorded.reason);
      return reply(`Answered. The session waiting on ${args.id} will pick this up within a second or two.`);
    })
  );

  tool(server, 'update_series', {
    title: 'Edit a scheduled task',
    annotations: WRITES,
    description:
      'Changes fields on an existing series — timing, engine, model, permission mode, a chain ' +
      'link. Fields not named in `patch` are left alone. The owner may set permissionMode here, ' +
      'unlike over the stdio agent channel.',
    inputSchema: z.object({
      instance: instanceArg,
      id: z.string().describe('Series id, from list_schedule'),
      patch: z.record(z.string(), z.unknown())
    })
  }, async (args) =>
    scoped(args, (inst) => {
      const out = editSeries(inst.paths, args.id, args.patch, { allowPermissionMode: true });
      return out.ok ? replyJson({ instance: inst.name, ...out.value }) : refuse(out.reason);
    })
  );

  tool(server, 'unschedule_series', {
    title: 'Take a task off the schedule',
    annotations: WRITES,
    description:
      'Removes a series and its run history. Anything chained after it is relinked onto whatever ' +
      'it was itself waiting on.',
    inputSchema: z.object({ instance: instanceArg, id: z.string().describe('Series id, from list_schedule') })
  }, async (args) =>
    scoped(args, (inst) => {
      const out = removeSeries(inst.paths, args.id);
      return out.ok ? replyJson({ instance: inst.name, ...out.value }) : refuse(out.reason);
    })
  );

  tool(server, 'run_now', {
    title: 'Run a scheduled task now',
    annotations: WRITES,
    description:
      'Queues a manual run right away. The desktop scheduler on this folder picks it up on its ' +
      'next tick, within about 30 seconds — this call itself does not start anything.',
    inputSchema: z.object({
      instance: instanceArg,
      seriesId: z.string().describe('Series id, from list_schedule'),
      dismissRunId: z.string().optional().describe('A run row to drop at the same time, e.g. a stale missed run')
    })
  }, async (args) =>
    scoped(args, (inst) => {
      const out = runSeriesNow(inst.paths, args.seriesId, { dismissRunId: args.dismissRunId });
      return out.ok
        ? replyJson({ instance: inst.name, run: out.value.run, note: out.value.note })
        : refuse(out.reason);
    })
  );

  tool(server, 'rerun_run', {
    title: 'Re-run a past run',
    annotations: WRITES,
    description:
      'Runs whatever series a past run belongs to, right away. Same timing as run_now: the ' +
      'desktop scheduler picks it up on its next tick, within about 30 seconds.',
    inputSchema: z.object({ instance: instanceArg, runId: z.string().describe('A run id from list_runs') })
  }, async (args) =>
    scoped(args, (inst) => {
      const out = rerunRun(inst.paths, args.runId);
      return out.ok
        ? replyJson({ instance: inst.name, run: out.value.run, note: out.value.note })
        : refuse(out.reason);
    })
  );

  tool(server, 'dismiss_run', {
    title: 'Dismiss a run',
    annotations: WRITES,
    description: 'Drops one run from the history. Refused while it is still in progress.',
    inputSchema: z.object({ instance: instanceArg, runId: z.string().describe('A run id from list_runs') })
  }, async (args) =>
    scoped(args, (inst) => {
      const out = dismissRun(inst.paths, args.runId);
      return out.ok ? replyJson({ instance: inst.name, ...out.value }) : refuse(out.reason);
    })
  );

  tool(server, 'create_plan', {
    title: 'Create a plan',
    annotations: WRITES,
    description:
      'Writes a new Markdown plan into the library. Does not schedule it — call schedule_plan ' +
      'with the name this returns.',
    inputSchema: z.object({
      instance: instanceArg,
      title: z.string().min(1).max(200).describe('Plain-language title; the file name is derived from it'),
      body: z.string().max(500_000).optional().describe('The plan itself, as Markdown. Omit for a starter plan.')
    })
  }, async (args) =>
    scoped(args, (inst) => {
      const out = createPlanAction(inst.paths, args.title, args.body);
      return out.ok ? replyJson({ instance: inst.name, ...out.value }) : refuse(out.reason);
    })
  );

  tool(server, 'save_plan', {
    title: 'Save a plan’s text',
    annotations: WRITES,
    description: 'Overwrites an existing plan’s Markdown body.',
    inputSchema: z.object({
      instance: instanceArg,
      name: z.string().describe('Plan file name, from list_plans'),
      text: z.string().describe('The full replacement body')
    })
  }, async (args) =>
    scoped(args, (inst) => {
      const out = savePlanAction(inst.paths, args.name, args.text);
      return out.ok ? reply(`Saved ${args.name}.`) : refuse(out.reason);
    })
  );

  tool(server, 'rename_plan', {
    title: 'Rename a plan',
    annotations: WRITES,
    description: 'Renames a plan file and repoints every series scheduled against it onto the new name.',
    inputSchema: z.object({
      instance: instanceArg,
      name: z.string().describe('Plan file name, from list_plans'),
      newTitle: z.string().describe('The new title; the file name is derived from it')
    })
  }, async (args) =>
    scoped(args, (inst) => {
      const out = renamePlanAction(inst.paths, args.name, args.newTitle);
      return out.ok ? replyJson({ instance: inst.name, ...out.value }) : refuse(out.reason);
    })
  );

  tool(server, 'archive_plan', {
    title: 'Archive a plan',
    annotations: WRITES,
    description:
      'Moves a plan out of the library into its archive, dropping every series scheduled against ' +
      'it first — and anything chained after one of them is relinked, the same as unschedule_series.',
    inputSchema: z.object({ instance: instanceArg, name: z.string().describe('Plan file name, from list_plans') })
  }, async (args) =>
    scoped(args, (inst) => {
      const out = archivePlanAction(inst.paths, args.name);
      return out.ok ? replyJson({ instance: inst.name, ...out.value }) : refuse(out.reason);
    })
  );

  tool(server, 'edit_task', {
    title: 'Edit a captured task',
    annotations: WRITES,
    description: 'Overwrites a task’s text in the inbox.',
    inputSchema: z.object({
      instance: instanceArg,
      name: z.string().describe('Task file name, from list_tasks'),
      text: z.string().describe('The full replacement text')
    })
  }, async (args) =>
    scoped(args, (inst) => {
      const out = editTaskAction(inst.paths, args.name, args.text);
      return out.ok ? reply(`Saved ${args.name}.`) : refuse(out.reason);
    })
  );

  tool(server, 'delete_task', {
    title: 'Delete a captured task',
    annotations: WRITES,
    description: 'Moves a task out of the inbox into its archive.',
    inputSchema: z.object({ instance: instanceArg, name: z.string().describe('Task file name, from list_tasks') })
  }, async (args) =>
    scoped(args, (inst) => {
      const out = deleteTaskAction(inst.paths, args.name);
      return out.ok ? replyJson({ instance: inst.name, ...out.value }) : refuse(out.reason);
    })
  );

  tool(server, 'run_task', {
    title: 'Run a task directly',
    annotations: WRITES,
    description:
      'Imports an inbox task into the plan library and runs it right away, once, in `auto` ' +
      'permission mode. Unlike running a task from the Tasks panel, this leaves the task in the ' +
      'inbox — there is no link back to it from here to clear it automatically.',
    inputSchema: z.object({
      instance: instanceArg,
      name: z.string().describe('Task file name, from list_tasks'),
      model: z.string().optional().describe('Model id. Omit for the account default.')
    })
  }, async (args) =>
    scoped(args, (inst) => {
      const out = runTaskAction(inst.paths, args.name, { model: args.model });
      return out.ok
        ? replyJson({ instance: inst.name, series: out.value.series, note: out.value.note })
        : refuse(out.reason);
    })
  );

  tool(server, 'chain_plans', {
    title: 'Chain plans',
    annotations: WRITES,
    description:
      'Links several plans to run one after another: the first starts at the given time, and each ' +
      'plan after it is armed once the one before it finishes. A plan already on the schedule ' +
      'keeps its series and history — only its timing changes. Runs still fire on the desktop ' +
      'scheduler’s own tick, the same ≤30s delay as run_now.',
    inputSchema: z.object({
      instance: instanceArg,
      names: z.array(z.string()).min(2).describe('Plan file names, from list_plans, in run order'),
      startIso: z.string().describe('ISO 8601 date and time the first plan starts'),
      gapMinutes: z.number().int().min(0).max(MAX_CHAIN_DELAY_MINUTES),
      stopOnFailure: z.boolean().describe('Stop the chain if a plan fails instead of continuing to the next'),
      agent: z.enum(['claude', 'opencode', 'codex']).optional(),
      model: z.string().optional(),
      permissionMode: z.enum(['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'manual', 'plan']).optional()
    })
  }, async (args) =>
    scoped(args, (inst) => {
      const { instance: _instance, ...rest } = args;
      const out = chainPlansAction(inst.paths, rest as ChainPlansArgs, { maxRetries: DEFAULT_MAX_RETRIES });
      return out.ok
        ? replyJson({ instance: inst.name, series: out.value.series, note: out.value.note })
        : refuse(out.reason);
    })
  );

  tool(server, 'append_to_chain', {
    title: 'Append a plan to a chain',
    annotations: WRITES,
    description:
      'Adds one plan to the end of an existing chain. The new link copies its delay and ' +
      "stop-on-failure from the chain's last link; a plan already on the schedule keeps its " +
      'series and history. Refused if the plan is already part of a chain.',
    inputSchema: z.object({
      instance: instanceArg,
      seriesId: z.string().describe('Any series in the chain, from read_instance'),
      name: z.string().describe('Plan file name to append, from list_plans')
    })
  }, async (args) =>
    scoped(args, (inst) => {
      const out = appendToChainAction(
        inst.paths,
        { seriesId: args.seriesId, name: args.name },
        { maxRetries: DEFAULT_MAX_RETRIES }
      );
      return out.ok ? replyJson({ instance: inst.name, series: out.value.series }) : refuse(out.reason);
    })
  );

  tool(server, 'cancel_run', {
    title: 'Cancel a running task',
    annotations: WRITES,
    description:
      'Asks whichever live editor window holds the process for a running run to kill it. Refused ' +
      'immediately unless that run is currently running. Needs a live window on this folder — if ' +
      'none answers within a few seconds the command is left on disk for one to pick up later.',
    inputSchema: z.object({ instance: instanceArg, runId: z.string().describe('A run id from list_runs') })
  }, async (args) =>
    scoped(args, async (inst) => {
      const { state } = readState(inst.paths.state);
      const run = state.runs.find((r) => r.id === args.runId);
      if (!run) return refuse(`No run has that id in ${inst.name}.`);
      if (run.status !== 'running') {
        return refuse(`That run is ${run.status}, not running — there is nothing to cancel.`);
      }

      const command = writeCommand(ensureWritable(inst.paths).control, {
        kind: 'cancelRun',
        runId: args.runId,
        source: 'hub'
      });
      const outcome = await pollCommand(inst.paths.control, command.id, CANCEL_TIMEOUT_MS, COMMAND_POLL_MS);
      if (!outcome) {
        return reply('Cancel requested — no window has confirmed yet. The command stays on disk for one to pick up.');
      }
      return outcome.ok
        ? reply(`Cancelled.${outcome.note ? ` ${outcome.note}` : ''}`)
        : refuse(outcome.note ?? 'The window refused the cancel.');
    })
  );

  tool(server, 'update_setting', {
    title: 'Change a global setting',
    annotations: WRITES,
    description:
      'Writes one Synchrony setting through a live editor window, the same validation a setting ' +
      'typed into the manager’s Settings page gets. Settings are global — shared by every ' +
      'instance on this machine, not scoped to the folder named here. Needs a live window on this ' +
      'folder; if none answers within a few seconds the command is left on disk for one to pick up.',
    inputSchema: z.object({
      instance: instanceArg,
      key: z.string().describe('Setting key with no "synchrony." prefix, e.g. "maxRetries"'),
      value: z.unknown()
    })
  }, async (args) =>
    scoped(args, async (inst) => {
      const command = writeCommand(ensureWritable(inst.paths).control, {
        kind: 'updateSetting',
        key: args.key,
        value: args.value,
        source: 'hub'
      });
      const outcome = await pollCommand(inst.paths.control, command.id, SETTING_TIMEOUT_MS, COMMAND_POLL_MS);
      if (!outcome) {
        return reply('Queued — no window has confirmed yet. The command stays on disk for one to pick up.');
      }
      return outcome.ok
        ? reply(`Applied.${outcome.note ? ` ${outcome.note}` : ''}`)
        : refuse(outcome.note ?? 'That setting was refused.');
    })
  );

  return server;
}

const COMMAND_POLL_MS = 250;
const CANCEL_TIMEOUT_MS = 5_000;
const SETTING_TIMEOUT_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls a control command until it is done or `timeoutMs` has passed. */
async function pollCommand(
  dir: string,
  id: string,
  timeoutMs: number,
  intervalMs: number
): Promise<ControlOutcome | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (commandStatus(dir, id) === 'done') {
      return readControlOutcome(dir, id)?.outcome;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await sleep(intervalMs);
  }
}

function safeRead(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

///////////////////////////*HTTP*////////////////////////////

const handler = createMcpHandler(() => buildServer(), {
  onerror: (err) => note(`handler: ${err.message}`)
});

/** Node's request as a web-standard Request, body streamed rather than buffered. */
function toWebRequest(req: http.IncomingMessage, urlPath: string): Request {
  const url = `http://${req.headers.host ?? `${HOST}:${PORT}`}${urlPath}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>) : undefined,
    // Required by undici when the body is a stream.
    ...(hasBody ? { duplex: 'half' as const } : {})
  } as RequestInit);
}

async function writeWebResponse(res: http.ServerResponse, out: Response): Promise<void> {
  res.statusCode = out.status;
  out.headers.forEach((v, k) => res.setHeader(k, v));
  if (!out.body) {
    res.end();
    return;
  }
  const reader = out.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

const server = http.createServer((req, res) => {
  const rawUrl = req.url ?? '/';
  const qAt = rawUrl.indexOf('?');
  const pathname = qAt >= 0 ? rawUrl.slice(0, qAt) : rawUrl;
  const query = qAt >= 0 ? rawUrl.slice(qAt) : '';

  if (pathname === '/healthz') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, version: VERSION, instances: discover().length }));
    return;
  }

  // Either credential opens the door; the path form also decides which path
  // the SDK sees, so `/<token>/mcp` is served as `/mcp`.
  const stripped = pathWithoutToken(pathname);
  const authorized = stripped !== undefined || headerMatches(req.headers.authorization);
  if (!authorized) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  const servedPath = (stripped !== undefined ? stripped || '/' : pathname) + query;

  handler
    .fetch(toWebRequest(req, servedPath))
    .then((out) => writeWebResponse(res, out))
    .catch((err) => {
      note(`request failed: ${String(err)}`);
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      res.end();
    });
});

server.listen(PORT, HOST, () => {
  const found = discover();
  note(`synchrony-hub ${VERSION} listening on http://${HOST}:${PORT}`);
  note(`serving ${found.length} instance(s): ${found.map((i) => i.name).join(', ') || '(none yet)'}`);
  note(`token file: ${TOKEN_FILE}`);
  // The shape of the URL, never the token itself: this line runs on every
  // start, and stderr is routinely captured to a file. `loadToken` prints the
  // secret exactly once, when it mints it, and a restart must not print it again.
  note(`connector URL (put your tunnel's https host in front of the path): http://${HOST}:${PORT}/<token>/mcp — the token is in the file above`);
});

const shutdown = () => {
  note('shutting down');
  server.close();
  void handler.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

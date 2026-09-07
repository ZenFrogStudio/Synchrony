import { createMcpHandler, McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { randomBytes, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { z } from 'zod';
import * as library from './library';
import {
  captureTask,
  describeRun,
  describeSeries,
  requestPlan,
  ScheduleArgs,
  scheduleSeries,
  summarizeInstance
} from './mcp-actions';
import { planAnswers } from './mcp-tools';
import { listQuestions, readQuestion, recordAnswers } from './questions';
import { ChronosPaths, pathsFor, ROOT_DIR } from './roots';
import { readState } from './state-file';

/**
 * The Chronos hub: one MCP server, over HTTP, for every project on this machine.
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
 *   //Discover instances: every immediate child of a root with a `.chronos`;
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

const VERSION = process.env.CHRONOS_VERSION ?? '0.0.0-dev';
const DEFAULT_PORT = 7433;
const DEFAULT_MAX_RETRIES = 3;
const HUB_DIR = path.join(os.homedir(), '.chronos-dashboard');
const DEFAULT_TOKEN_FILE = path.join(HUB_DIR, 'hub.token');

function note(text: string): void {
  process.stderr.write(`[chronos-hub] ${text}\n`);
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
const PORT = Number(argValues(ARGV, '--port')[0] ?? process.env.CHRONOS_HUB_PORT ?? DEFAULT_PORT);
const HOST = argValues(ARGV, '--host')[0] ?? process.env.CHRONOS_HUB_HOST ?? '127.0.0.1';
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
  const fromEnv = process.env.CHRONOS_HUB_TOKEN?.trim();
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
  paths: ChronosPaths;
}

/**
 * Every project this hub speaks for, re-read on each call so a folder created
 * after start-up appears without a restart. A project is a folder with a
 * `.chronos` directory in it; the folder's own name is the instance name.
 */
function discover(): Instance[] {
  const seen = new Map<string, Instance>();
  const add = (folder: string) => {
    if (!fs.existsSync(path.join(folder, ROOT_DIR))) return;
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
  const server = new McpServer({ name: 'chronos-hub', version: VERSION }, { capabilities: { tools: {} } });

  // ---------- read ----------

  tool(server, 'list_instances', {
    title: 'List Chronos instances',
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
      'The session asks its questions through Chronos (see list_questions / answer_question) and ' +
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

  return server;
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
  note(`chronos-hub ${VERSION} listening on http://${HOST}:${PORT}`);
  note(`serving ${found.length} instance(s): ${found.map((i) => i.name).join(', ') || '(none yet)'}`);
  note(`token file: ${TOKEN_FILE}`);
  note(`connector URL (put your tunnel's https host in front of the path): http://${HOST}:${PORT}/${TOKEN}/mcp`);
});

const shutdown = () => {
  note('shutting down');
  server.close();
  void handler.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Plan requests: how something outside a VS Code window asks a live window to
 * start a planning session.
 *
 * Plan generation is the one thing the `.synchrony` tree cannot express on its
 * own. A task is a file, a series is a line in `state.json`, and any process can
 * write either — but a planning session is a terminal running the `claude` CLI,
 * and only an extension host can open one. So a remote caller writes a request
 * file into `.synchrony/requests/`, and whichever live window on that folder
 * claims it first opens the session on the caller's behalf.
 *
 * The protocol is three renames, each atomic on NTFS and POSIX:
 *
 *   <id>.json           written by the requester; unclaimed
 *   <id>.claimed.json   renamed by exactly one window — a second window's rename
 *                       fails because the source is gone, and that failure is
 *                       how it learns it lost
 *   <id>.done.json      renamed by the winner once the session was opened (or
 *                       could not be), with the outcome merged in
 *
 * Nothing here imports `vscode`, so the hub, the stdio MCP server and the tests
 * can all use it; the extension adds the watcher and the terminal.
 */

export const REQUESTS_DIR = 'requests';

export interface PlanRequest {
  id: string;
  type: 'generatePlan';
  /** Task file name inside `.synchrony/tasks/`, e.g. `fix-the-lock.md`. Never a path. */
  task: string;
  /** Several stage plans and a manifest rather than one plan. */
  series?: boolean;
  /** Model id for the planning session. Omit for the window's `synchrony.planModel`. */
  model?: string;
  /** ISO 8601 UTC. */
  requestedAt: string;
  /** Who asked — a hub token label, an MCP client name — for the log line. */
  source?: string;
}

export interface RequestOutcome {
  ok: boolean;
  note?: string;
  /** ISO 8601 UTC. */
  finishedAt: string;
}

export type ClaimResult =
  | { claimed: true; request: PlanRequest }
  | { claimed: false; reason: 'gone' | 'unreadable' };

export function newRequestId(): string {
  return randomBytes(6).toString('hex');
}

/** A task name is a bare file name. Anything that could leave `tasks/` is refused. */
export function isTaskName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 255 &&
    name === path.basename(name) &&
    !name.startsWith('.') &&
    name.toLowerCase().endsWith('.md')
  );
}

const unclaimedPath = (dir: string, id: string) => path.join(dir, `${id}.json`);
const claimedPath = (dir: string, id: string) => path.join(dir, `${id}.claimed.json`);
const donePath = (dir: string, id: string) => path.join(dir, `${id}.done.json`);

/** Writes an unclaimed request. Creates the directory; returns the request as written. */
export function writeRequest(
  dir: string,
  input: Omit<PlanRequest, 'id' | 'requestedAt' | 'type'> & Partial<Pick<PlanRequest, 'id'>>
): PlanRequest {
  if (!isTaskName(input.task)) {
    throw new Error(`Not a task file name: ${JSON.stringify(input.task)}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const request: PlanRequest = {
    id: input.id ?? newRequestId(),
    type: 'generatePlan',
    task: input.task,
    requestedAt: new Date().toISOString(),
    ...(input.series ? { series: true } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.source ? { source: input.source } : {})
  };
  // Temp-and-rename, like `state.json`: a watcher that fires on create must
  // never read a half-written body.
  const temp = path.join(dir, `.${request.id}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(request, null, 2), 'utf8');
  fs.renameSync(temp, unclaimedPath(dir, request.id));
  return request;
}

/** Ids of requests nobody has claimed yet, oldest first. */
export function listUnclaimed(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json') && !n.endsWith('.claimed.json') && !n.endsWith('.done.json'))
    .map((n) => n.slice(0, -'.json'.length))
    .filter((id) => /^[a-z0-9]+$/i.test(id))
    .sort();
}

/**
 * Claims one request. Exactly one caller wins the rename; everyone else gets
 * `gone`. A winner that then finds the body unreadable still owns the file and
 * marks it done with a failure, so a corrupt request cannot be claimed forever.
 */
export function claimRequest(dir: string, id: string): ClaimResult {
  try {
    fs.renameSync(unclaimedPath(dir, id), claimedPath(dir, id));
  } catch {
    return { claimed: false, reason: 'gone' };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(claimedPath(dir, id), 'utf8')) as PlanRequest;
    if (parsed.type !== 'generatePlan' || !isTaskName(parsed.task)) {
      throw new Error('not a plan request');
    }
    return { claimed: true, request: { ...parsed, id } };
  } catch (err) {
    finishRequest(dir, id, { ok: false, note: `unreadable request: ${String(err)}` });
    return { claimed: false, reason: 'unreadable' };
  }
}

/** Marks a claimed request finished, merging the outcome into the file. */
export function finishRequest(dir: string, id: string, outcome: Omit<RequestOutcome, 'finishedAt'>): void {
  const from = claimedPath(dir, id);
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(fs.readFileSync(from, 'utf8')) as Record<string, unknown>;
  } catch {
    // Keep going: the outcome is still worth writing.
  }
  const done: Record<string, unknown> = {
    ...body,
    id,
    outcome: { ...outcome, finishedAt: new Date().toISOString() } satisfies RequestOutcome
  };
  fs.writeFileSync(donePath(dir, id), JSON.stringify(done, null, 2), 'utf8');
  try {
    fs.unlinkSync(from);
  } catch {
    // Already gone, or unlinkable: the done file is the record either way.
  }
}

/**
 * Refuses every unclaimed request beyond the oldest `keep`: claims it and marks
 * it done with a failure, so a flood of request files cannot open a session
 * each. Returns the refused ids. Requests another window claims first are
 * skipped — that window's sweep applies its own cap.
 */
export function refuseExcess(dir: string, keep: number): string[] {
  const excess = listUnclaimed(dir).slice(keep);
  const refused: string[] = [];
  for (const id of excess) {
    const claim = claimRequest(dir, id);
    if (!claim.claimed) continue; // gone (another window) or unreadable (already marked)
    finishRequest(dir, id, {
      ok: false,
      note: `refused: more than ${keep} requests pending at once; resend later`
    });
    refused.push(id);
  }
  return refused;
}

/** The outcome of a finished request, or undefined while it is unclaimed or in flight. */
export function readOutcome(dir: string, id: string): (PlanRequest & { outcome: RequestOutcome }) | undefined {
  try {
    return JSON.parse(fs.readFileSync(donePath(dir, id), 'utf8')) as PlanRequest & { outcome: RequestOutcome };
  } catch {
    return undefined;
  }
}

/** Where a request stands, for a caller polling after `writeRequest`. */
export function requestStatus(dir: string, id: string): 'unclaimed' | 'claimed' | 'done' | 'unknown' {
  if (fs.existsSync(donePath(dir, id))) return 'done';
  if (fs.existsSync(claimedPath(dir, id))) return 'claimed';
  if (fs.existsSync(unclaimedPath(dir, id))) return 'unclaimed';
  return 'unknown';
}

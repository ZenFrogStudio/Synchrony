import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Control commands: how something outside a VS Code window reaches into a live
 * window to cancel a run or write a setting — the two things only an extension
 * host can do. The protocol is the same three renames `requests.ts` uses, for
 * the same reason: reinventing it here would just be a second thing to keep in
 * sync.
 *
 *   <id>.json           written by the caller; unclaimed
 *   <id>.claimed.json   renamed by exactly one window — a second window's rename
 *                       fails because the source is gone, and that failure is
 *                       how it learns it lost
 *   <id>.done.json      renamed by the claimer once handled, with the outcome
 *                       merged in
 *
 * Nothing here imports `vscode`, so the hub, the stdio MCP server and the tests
 * can all use it; `control-watcher.ts` adds the watcher and the vscode calls.
 */

export type ControlCommand = { id: string; requestedAt: string; source?: string } & (
  | { kind: 'cancelRun'; runId: string }
  | { kind: 'updateSetting'; key: string; value: unknown }
);

/** The body of a command as written, before an id is assigned to it. */
type ControlBody = { requestedAt: string; source?: string } & (
  | { kind: 'cancelRun'; runId: string }
  | { kind: 'updateSetting'; key: string; value: unknown }
);

export interface ControlOutcome {
  ok: boolean;
  note?: string;
  /** ISO 8601 UTC. */
  finishedAt: string;
}

export type ClaimResult =
  | { claimed: true; command: ControlCommand }
  | { claimed: false; reason: 'gone' | 'unreadable' };

export function newCommandId(): string {
  return randomBytes(6).toString('hex');
}

function isControlBody(value: unknown): value is ControlBody {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.requestedAt !== 'string') {
    return false;
  }
  if (v.source !== undefined && typeof v.source !== 'string') {
    return false;
  }
  if (v.kind === 'cancelRun') {
    return typeof v.runId === 'string' && v.runId.length > 0;
  }
  if (v.kind === 'updateSetting') {
    return typeof v.key === 'string' && v.key.length > 0;
  }
  return false;
}

const unclaimedPath = (dir: string, id: string) => path.join(dir, `${id}.json`);
const claimedPath = (dir: string, id: string) => path.join(dir, `${id}.claimed.json`);
const donePath = (dir: string, id: string) => path.join(dir, `${id}.done.json`);

/** Writes an unclaimed command. Creates the directory; returns the command as written. */
export function writeCommand(
  dir: string,
  input: ({ kind: 'cancelRun'; runId: string } | { kind: 'updateSetting'; key: string; value: unknown }) & {
    id?: string;
    source?: string;
  }
): ControlCommand {
  fs.mkdirSync(dir, { recursive: true });
  const command = {
    ...input,
    id: input.id ?? newCommandId(),
    requestedAt: new Date().toISOString()
  } as ControlCommand;

  // Temp-and-rename, like `requests.ts`: a watcher that fires on create must
  // never read a half-written body.
  const temp = path.join(dir, `.${command.id}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(command, null, 2), 'utf8');
  fs.renameSync(temp, unclaimedPath(dir, command.id));
  return command;
}

/** Ids of commands nobody has claimed yet, oldest first. */
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
 * Best-effort read of an unclaimed command without claiming it — for deciding
 * whether *this* window should even attempt the claim (does its `Runner` own
 * the run, is the command stale) before racing the rename. A command that
 * cannot be read this way is not necessarily corrupt — `writeCommand` briefly
 * holds it as a temp file too — so `undefined` here means "not decidable yet",
 * not "invalid"; `claimCommand` is what makes that call for real.
 */
export function peekUnclaimed(dir: string, id: string): ControlCommand | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(unclaimedPath(dir, id), 'utf8')) as unknown;
    if (!isControlBody(parsed)) {
      return undefined;
    }
    return { ...parsed, id };
  } catch {
    return undefined;
  }
}

/**
 * Claims one command. Exactly one caller wins the rename; everyone else gets
 * `gone`. A winner that then finds the body unreadable or of an unknown kind
 * still owns the file and marks it done with a failure, so a corrupt or
 * unrecognised command cannot be claimed forever.
 */
export function claimCommand(dir: string, id: string): ClaimResult {
  try {
    fs.renameSync(unclaimedPath(dir, id), claimedPath(dir, id));
  } catch {
    return { claimed: false, reason: 'gone' };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(claimedPath(dir, id), 'utf8')) as unknown;
    if (!isControlBody(parsed)) {
      throw new Error('not a control command');
    }
    return { claimed: true, command: { ...parsed, id } };
  } catch (err) {
    finishCommand(dir, id, { ok: false, note: `unreadable command: ${String(err)}` });
    return { claimed: false, reason: 'unreadable' };
  }
}

/** Marks a claimed command finished, merging the outcome into the file. */
export function finishCommand(dir: string, id: string, outcome: Omit<ControlOutcome, 'finishedAt'>): void {
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
    outcome: { ...outcome, finishedAt: new Date().toISOString() } satisfies ControlOutcome
  };
  fs.writeFileSync(donePath(dir, id), JSON.stringify(done, null, 2), 'utf8');
  try {
    fs.unlinkSync(from);
  } catch {
    // Already gone, or unlinkable: the done file is the record either way.
  }
}

/** The outcome of a finished command, or undefined while it is unclaimed or in flight. */
export function readOutcome(dir: string, id: string): (ControlCommand & { outcome: ControlOutcome }) | undefined {
  try {
    return JSON.parse(fs.readFileSync(donePath(dir, id), 'utf8')) as ControlCommand & { outcome: ControlOutcome };
  } catch {
    return undefined;
  }
}

/** Where a command stands, for a caller polling after `writeCommand`. */
export function commandStatus(dir: string, id: string): 'unclaimed' | 'claimed' | 'done' | 'unknown' {
  if (fs.existsSync(donePath(dir, id))) return 'done';
  if (fs.existsSync(claimedPath(dir, id))) return 'claimed';
  if (fs.existsSync(unclaimedPath(dir, id))) return 'unclaimed';
  return 'unknown';
}

import {
  COMMAND_MAX_SKEW_MS,
  DAILY,
  Recurrence,
  TaskRun,
  TaskSeries
} from './types';

/**
 * What a phone is allowed to ask the desktop to do.
 *
 * This module *is* the security boundary. Chronos defaults new tasks to
 * `bypassPermissions`, so a remote channel that could change what a plan says —
 * or which permissions it runs under — would be a "run arbitrary code on my dev
 * machine" button reachable from any network. Instead the phone may only change
 * *when* something runs, never *what* it does.
 *
 * Pure — no `vscode`, no network, no store — so every rejection path below is a
 * unit test rather than something we hope is right. `Scheduler` fetches the
 * commands and applies the verdicts; this decides.
 */

/** The complete set. Anything not on this list is rejected unread. */
const ALLOWED = ['reschedule', 'setRepeat', 'setEnabled', 'runNow', 'dismissRun'] as const;

export type CommandKind = (typeof ALLOWED)[number];

/** As it arrives off the wire. Every field is untrusted. */
export interface RemoteCommand {
  id: string;
  kind: string;
  seriesId?: string;
  runId?: string;
  /** ISO 8601 UTC, stamped by the phone when you tapped. */
  createdAt: string;
  payload?: Record<string, unknown>;
}

export type CommandVerdict =
  | { ok: true; kind: 'series'; id: string; patch: Partial<TaskSeries> }
  | { ok: true; kind: 'runNow'; seriesId: string }
  | { ok: true; kind: 'dismissRun'; runId: string }
  /** `stale` is reported separately so the phone can say "too old", not "refused". */
  | { ok: false; reason: string; stale?: boolean };

export interface CommandInput {
  command: RemoteCommand;
  series: readonly TaskSeries[];
  runs: readonly TaskRun[];
  /** Epoch ms. */
  now: number;
  ttlMs: number;
}

/**
 * A reschedule target this far in the past is a stale tap rather than an
 * intention. Anything nearer is let through to fire immediately.
 */
const PAST_TOLERANCE_MS = 5 * 60_000;

export function validateCommand(input: CommandInput): CommandVerdict {
  const { command, now, ttlMs } = input;

  const issuedAt = parseInstant(command.createdAt);
  if (issuedAt === undefined) {
    return reject('Command has no valid timestamp.');
  }
  if (issuedAt - now > COMMAND_MAX_SKEW_MS) {
    return reject('Command is dated too far in the future.');
  }
  if (now - issuedAt > ttlMs) {
    return { ok: false, reason: 'Command is too old to apply.', stale: true };
  }

  if (!isAllowed(command.kind)) {
    return reject(`Unsupported command: ${String(command.kind)}`);
  }

  if (command.kind === 'dismissRun') {
    if (!command.runId || !input.runs.some((r) => r.id === command.runId)) {
      return reject('That run no longer exists.');
    }
    return { ok: true, kind: 'dismissRun', runId: command.runId };
  }

  const series = input.series.find((s) => s.id === command.seriesId);
  if (!series) {
    return reject('That task no longer exists.');
  }

  switch (command.kind) {
    case 'runNow':
      return { ok: true, kind: 'runNow', seriesId: series.id };
    case 'setEnabled':
      return setEnabled(series, command.payload);
    case 'reschedule':
      return reschedule(series, command.payload, now);
    case 'setRepeat':
      return setRepeat(series, command.payload);
  }
}

// ---------- per-command rules ----------

/**
 * Deliberately narrower than the desktop's pause toggle, which also clears
 * `spent` on resume. Doing that here would revive a fired one-shot whose
 * `nextRunAt` is long past, and it would immediately be marked missed. From a
 * phone, "resume" should not produce a missed-run notification — use
 * `reschedule`, which sets a real future time.
 */
function setEnabled(series: TaskSeries, payload: unknown): CommandVerdict {
  const enabled = field(payload, 'enabled');
  if (typeof enabled !== 'boolean') {
    return reject('setEnabled needs a true or false value.');
  }
  return { ok: true, kind: 'series', id: series.id, patch: { enabled } };
}

/**
 * Moving a recurring task's time moves its rule with it, matching the manager's
 * own behaviour. `timeLocal` is derived here, in the desktop's timezone, which
 * is correct even when the phone is somewhere else: the wall clock that matters
 * is the one on the machine that runs the job.
 */
function reschedule(series: TaskSeries, payload: unknown, now: number): CommandVerdict {
  // A chained plan has no time of its own to move: the arming rule writes one
  // when the plan before it finishes, and would overwrite whatever was set from
  // here. Refused out loud rather than accepted and quietly undone.
  if (series.chain) {
    return reject('That plan runs after another one. Unlink it in Chronos first.');
  }

  const raw = field(payload, 'nextRunAt');
  const target = parseInstant(raw);
  if (target === undefined) {
    return reject('reschedule needs a valid date and time.');
  }
  if (now - target > PAST_TOLERANCE_MS) {
    return reject('That time has already passed.');
  }

  const iso = new Date(target).toISOString();
  // `spent` is cleared so a fired one-shot goes back on the schedule; `enabled`
  // is left alone, since silently un-pausing a task you paused is a surprise.
  const patch: Partial<TaskSeries> = { nextRunAt: iso, spent: false };
  if (series.recurrence) {
    patch.recurrence = { ...series.recurrence, timeLocal: localTimeOf(target) };
    // A monthly rule's day comes from the date it runs on, so moving the date
    // moves the rule — the same thing the manager's When field does.
    if (series.recurrence.dayOfMonth) {
      patch.recurrence.dayOfMonth = new Date(target).getDate();
    }
  }
  return { ok: true, kind: 'series', id: series.id, patch };
}

function setRepeat(series: TaskSeries, payload: unknown): CommandVerdict {
  const repeat = field(payload, 'repeat');

  if (repeat === 'once') {
    return { ok: true, kind: 'series', id: series.id, patch: { recurrence: null } };
  }

  const timeLocal = localTimeOf(Date.parse(series.nextRunAt));

  if (repeat === 'daily') {
    return recurrencePatch(series, { daysOfWeek: DAILY, timeLocal });
  }

  if (repeat === 'weekly') {
    const days = parseDays(field(payload, 'daysOfWeek'));
    if (!days) {
      return reject('A weekly rule needs at least one valid day.');
    }
    return recurrencePatch(series, { daysOfWeek: days, timeLocal });
  }

  if (repeat === 'monthly') {
    // The day is taken from the date the series already runs on, so there is
    // nothing extra for the phone to send — and nothing extra to validate.
    const dayOfMonth = new Date(Date.parse(series.nextRunAt)).getDate();
    return recurrencePatch(series, { daysOfWeek: [], timeLocal, dayOfMonth });
  }

  return reject('setRepeat expects once, daily, weekly or monthly.');
}

function recurrencePatch(series: TaskSeries, recurrence: Recurrence): CommandVerdict {
  return { ok: true, kind: 'series', id: series.id, patch: { recurrence } };
}

// ---------- helpers ----------

function isAllowed(kind: string): kind is CommandKind {
  return (ALLOWED as readonly string[]).includes(kind);
}

const reject = (reason: string): CommandVerdict => ({ ok: false, reason });

function field(payload: unknown, key: string): unknown {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  return (payload as Record<string, unknown>)[key];
}

function parseInstant(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Sorted and deduplicated, or undefined if anything in the list is not a day. */
function parseDays(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const days = new Set<number>();
  for (const entry of value) {
    if (!Number.isInteger(entry) || (entry as number) < 0 || (entry as number) > 6) {
      return undefined;
    }
    days.add(entry as number);
  }
  return [...days].sort((a, b) => a - b);
}

function localTimeOf(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

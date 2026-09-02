/**
 * The coding CLI a task runs through. Absent on a series means `claude`, which
 * is what every series stored before engines existed meant — so adding this
 * needed no migration and no SCHEMA_VERSION bump.
 */
export type AgentId = 'claude' | 'opencode' | 'codex';

/** Permission modes accepted by the `claude` CLI's --permission-mode flag. */
export type PermissionMode =
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'dontAsk'
  | 'manual'
  | 'plan';

export type RunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'missed'
  | 'cancelled';

export type MissedReason = 'sleep' | 'not-running';

/**
 * A recurrence rule. Stored as local wall-clock time on purpose: "every
 * weekday at 09:00" means 09:00 as the clock reads it, on both sides of a DST
 * boundary. Concrete UTC instants are derived from this, never incremented.
 */
export interface Recurrence {
  /** 0 = Sunday .. 6 = Saturday. Daily is simply all seven. */
  daysOfWeek: number[];
  /** "HH:MM", 24-hour, local time. */
  timeLocal: string;
  /**
   * Day of the month, 1–31. When set this is a monthly rule and `daysOfWeek` is
   * unused (stored as `[]`); a day past the end of a shorter month clamps to
   * that month's last day, so the 31st still fires in February rather than
   * silently skipping it. Optional and additive, like `AgentId` above — every
   * rule stored before monthly existed still parses, so this needed no
   * migration and no SCHEMA_VERSION bump.
   */
  dayOfMonth?: number;
}

/**
 * What arms a plan that has no clock time of its own: the plan before it in a
 * chain finishing. Optional and additive on `TaskSeries`, like `AgentId` and
 * `dayOfMonth` above — every series stored before chains existed still parses,
 * so this needed no migration and no SCHEMA_VERSION bump.
 */
export interface ChainLink {
  /** The series whose finished run arms this one. */
  after: string;
  /** Minutes to wait after that run finishes. 0 = straight away. */
  delayMinutes: number;
  /** Stop rather than carry on when that run fails, is cancelled or is missed. */
  stopOnFailure: boolean;
}

/** Longest gap a chain link may hold: a day. Beyond that, use a clock time. */
export const MAX_CHAIN_DELAY_MINUTES = 1440;

/** The definition: what you create when you drop a file. */
export interface TaskSeries {
  id: string;
  filePath: string;
  /** Basename, for display only. */
  fileName: string;
  /** Working directory for the agent process. */
  cwd: string;
  permissionMode: PermissionMode;
  /** Absent means `claude`. See `AgentId`. */
  agent?: AgentId;
  model?: string;
  /** null = one-shot. */
  recurrence: Recurrence | null;
  /** ISO 8601 UTC. The only field the scheduler tick reads. */
  nextRunAt: string;
  /**
   * User-controlled pause. False stops future occurrences *and* any retry
   * already queued — pausing a broken task should stop all of it.
   */
  enabled: boolean;
  /**
   * No occurrence is pending: a one-shot that has already fired or been missed,
   * or a chained plan parked until the one before it finishes. Distinct from
   * `enabled` on purpose: conflating "spent" with "paused" strands a
   * materialised run that has not found a concurrency slot yet — and a parked
   * follower must not look like a task the user switched off.
   */
  spent?: boolean;
  /**
   * Armed by another series finishing rather than by the clock. Absent for
   * every ordinary plan, including the first one in a chain — the head keeps a
   * real `nextRunAt` and is what starts the whole thing. See `chain.ts`.
   */
  chain?: ChainLink;
  /**
   * When this series last had its repeat rule removed, ISO 8601 UTC. Absent
   * means it has never repeated, or repeats now. Read only by `retire.ts`: a
   * plan that ran weekly for a month arrives at the archive test with a pile of
   * completed runs, and without this the sweep would move it out of the library
   * the moment Repeat was set to Once — before the one-shot occurrence had a
   * chance to fire. Optional and additive, like `agent` and `dayOfMonth` above,
   * so it needs no migration and no SCHEMA_VERSION bump.
   */
  repeatEndedAt?: string;
  maxRetries: number;
  createdAt: string;
}

/** One execution attempt. Immutable history once finished. */
export interface TaskRun {
  id: string;
  seriesId: string;
  /** ISO 8601 UTC — the occurrence this run was due for. */
  scheduledAt: string;
  status: RunStatus;
  /** 1 = first try, 2+ = retry. */
  attempt: number;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  lastError?: string;
  /** From claude's JSON output; enables --resume later. */
  sessionId?: string;
  costUsd?: number;
  /** Tools blocked by permission gating. A run can succeed with denials. */
  denials?: number;
  logPath?: string;
  /**
   * The agent's closing message, trimmed for display on a card. A scheduled run
   * is read after the fact, so "it completed" is not an answer on its own —
   * this is what it actually said. Full text lives in the transcript.
   */
  result?: string;
  /** Readable Markdown transcript of the run, on disk beside the raw log. */
  resultPath?: string;
  missedAt?: string;
  missedReason?: MissedReason;
  /** Occurrences collapsed into this one missed run. Absent means 1. */
  missedCount?: number;
  /**
   * Created by an explicit "Run now" rather than by the schedule. Manual runs
   * fire on a disabled series; scheduled runs and retries do not.
   */
  manual?: boolean;
  /** Credentials were rejected. Rendered distinctly; never retried. */
  authFailure?: boolean;
  /**
   * An hourly retry keeping a chain alive past its exhausted `maxRetries`. See
   * `retry.ts`. Optional and additive, like `manual` and `authFailure` above, so
   * it needs no migration and no SCHEMA_VERSION bump.
   */
  chainRecovery?: boolean;
}

export interface ChronosState {
  schemaVersion: number;
  series: TaskSeries[];
  runs: TaskRun[];
}

/**
 * Bump only alongside a step in `migrate()`. The store upgrades known older
 * versions; it does not discard them.
 */
export const SCHEMA_VERSION = 3;

/**
 * The `globalState` key state used to live under, before it moved to a
 * `state.json` in each folder's `.chronos`. Kept only so the one-time adoption
 * in `adopt.ts` can read what is still there; nothing writes it any more.
 */
export const STORE_KEY = 'chronos.state';

/** Scheduler tick. A gap larger than 3x this means the process was suspended. */
export const TICK_MS = 30_000;

/**
 * How long a scheduler lock survives without a heartbeat. Three missed ticks:
 * long enough that a busy window is not treated as gone, short enough that
 * closing one window hands scheduling to another within a minute or two.
 */
export const LOCK_STALE_MS = TICK_MS * 3;

/**
 * How long a remote command stays valid. Commands are applied synchronously, so
 * a legitimate one is only ever seconds old; this bounds how long a captured
 * request could be replayed, and would bound staleness if commands were ever
 * queued while the desktop was unreachable.
 */
export const COMMAND_TTL_MS = 6 * 60 * 60_000;

/**
 * Tolerance for a command dated in the future. Phone and desktop clocks drift;
 * a command dated far ahead would otherwise never expire.
 */
export const COMMAND_MAX_SKEW_MS = 60 * 60_000;

/** Every day of the week — the "daily" recurrence. */
export const DAILY: number[] = [0, 1, 2, 3, 4, 5, 6];

/** Finished runs retained in history. Recurring series would grow unbounded. */
export const MAX_RECENT_RUNS = 50;

/**
 * Missed runs retained. Capped separately and more generously than finished
 * ones: a missed run is still waiting for a decision, so it outlives a completed
 * one — but a pile ignored for months should not grow the store without bound.
 */
export const MAX_MISSED_RUNS = 100;

/**
 * Spent one-shot series retained. A fired one-shot is invisible in the manager
 * and read by nothing, but it is still rewritten on every change to the file, so
 * the list is held to a hundred of them.
 */
export const MAX_SPENT_SERIES = 100;

/** Error text stored per run. */
export const ERROR_MAX_CHARS = 500;

/**
 * Result text stored per run. Capped because `state.json` is read whole on every
 * write and is not the place for a full transcript — that goes in its own file.
 */
export const RESULT_MAX_CHARS = 600;

export function isFinished(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

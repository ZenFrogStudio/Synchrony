import * as os from 'os';
import * as path from 'path';
import { buildActivity } from './activity';
import { truncate } from './time';
import { RunStatus, TaskRun, TaskSeries, isFinished } from './types';

/**
 * What one editor window tells the browser dashboard about itself.
 *
 * Pure — no `vscode`, no store, no clock — for the same reason `activity.ts` is:
 * the shaping is the only real logic here, and logic that only runs inside an
 * extension host cannot be exercised by the plain Node test runner.
 * `dashboard-export.ts` supplies the clock, the paths and the writing; this
 * decides the shape. `scripts/dashboard-server.js` reads what this produces.
 */

/** Bump alongside a change the dashboard cannot read without knowing about. */
export const DASHBOARD_SCHEMA_VERSION = 1;

/** Shared directory under the user's home. One file per live window. */
export const DASHBOARD_DIR = '.chronos-dashboard';

/** How often a window rewrites its heartbeat when nothing has changed. */
export const HEARTBEAT_MS = 15_000;

/**
 * How long a heartbeat stays trustworthy. Three missed writes, the same margin
 * `LOCK_STALE_MS` gives the scheduler lock: long enough that a busy window is
 * not called gone, short enough that closing one shows up within a minute.
 */
export const STALE_MS = HEARTBEAT_MS * 3;

/** How far back a failure still counts as recent. */
export const FAILURE_WINDOW_MS = 24 * 60 * 60_000;

/** Entries per list. The heartbeat is a status file, not a history export. */
export const MAX_LISTED = 8;

/** Error text carried per entry. Full text stays in the run's transcript. */
export const DASHBOARD_ERROR_MAX_CHARS = 200;

/** Instance files left by windows that never wrote a closing heartbeat. */
export const ABANDONED_MS = 24 * 60 * 60_000;

export interface DashboardCounts {
  /** Series on the schedule: enabled, and with an occurrence still to come. */
  scheduled: number;
  running: number;
  pending: number;
  missed: number;
  /** Failures inside `FAILURE_WINDOW_MS`. */
  failedRecent: number;
}

/** One row on the dashboard: a run, or an occurrence that is not one yet. */
export interface DashboardEntry {
  seriesId: string;
  planTitle: string;
  /** ISO 8601 UTC. What orders the entry. */
  at: string;
  /** Absent means a future occurrence with no run record yet. */
  runId?: string;
  status?: RunStatus;
  attempt?: number;
  costUsd?: number;
  error?: string;
}

export interface DashboardInstance {
  schemaVersion: number;
  instanceId: string;
  processId: number;
  startedAt: string;
  lastHeartbeatAt: string;
  status: 'active' | 'stopped';
  /** The window's own root folder. Differs from `activeFolder` in multi-root. */
  workspaceFolder: string;
  workspaceName: string;
  /** The folder Chronos is pointed at in this window. */
  activeFolder: string;
  schedulerLeader: boolean;
  libraryPath: string;
  resultsPath: string;
  costLast7Days: number;
  counts: DashboardCounts;
  /** The next occurrence still in the future. Absent means nothing is due. */
  nextRunAt?: string;
  activeRuns: DashboardEntry[];
  /** Queued now plus scheduled ahead, soonest first. */
  upcoming: DashboardEntry[];
  /** Finished and missed, newest first. */
  recent: DashboardEntry[];
  missed: DashboardEntry[];
  failures: DashboardEntry[];
}

/** Everything the caller has to look up before the shape can be decided. */
export interface InstanceFacts {
  instanceId: string;
  processId: number;
  startedAt: string;
  /** Milliseconds since the epoch. Stamped as `lastHeartbeatAt`. */
  nowMs: number;
  status: 'active' | 'stopped';
  workspaceFolder: string;
  workspaceName: string;
  activeFolder: string;
  schedulerLeader: boolean;
  libraryPath: string;
  resultsPath: string;
  /** From `Store.costLast7Days()` — not recomputed here, so the two cannot drift. */
  costLast7Days: number;
  series: readonly TaskSeries[];
  runs: readonly TaskRun[];
}

/** Where every window on this machine writes its heartbeat. */
export function instancesDir(home: string = os.homedir()): string {
  return path.join(home, DASHBOARD_DIR, 'instances');
}

/**
 * One window's status, as the dashboard reads it.
 *
 * `buildActivity` decides what is coming up and what already happened, so the
 * dashboard and the manager's Runs panel order the same work the same way. The
 * lists here are that answer, capped and annotated with the run detail a
 * status row needs: how it ended, what it cost, what went wrong.
 */
export function buildInstancePayload(facts: InstanceFacts): DashboardInstance {
  const { series, runs, nowMs } = facts;
  const runById = new Map(runs.map((r) => [r.id, r]));
  const titleOf = titleLookup(series);

  const activity = buildActivity(series, runs, nowMs);
  const detail = (entry: { seriesId: string; planTitle: string; at: string; runId?: string }) =>
    withRunDetail(entry, entry.runId ? runById.get(entry.runId) : undefined);

  // Due now and waiting for a concurrency slot. `buildActivity` files these
  // under "already happened" — their scheduled time has passed — but on an
  // operations board they are queued work, so they join the upcoming list.
  const queuedNow = runs
    .filter((r) => r.status === 'pending' && Date.parse(r.scheduledAt) <= nowMs)
    .map((r) => detail({ seriesId: r.seriesId, planTitle: titleOf(r.seriesId), at: r.scheduledAt, runId: r.id }));

  const upcoming = [...activity.upcoming.map(detail), ...queuedNow].sort((a, b) =>
    a.at.localeCompare(b.at)
  );

  const recent = activity.recent
    .map(detail)
    .filter((e) => e.status !== undefined && (isFinished(e.status) || e.status === 'missed'));

  const failedRecent = runs.filter(
    (r) => r.status === 'failed' && nowMs - Date.parse(r.finishedAt ?? r.scheduledAt) <= FAILURE_WINDOW_MS
  );

  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    instanceId: facts.instanceId,
    processId: facts.processId,
    startedAt: facts.startedAt,
    lastHeartbeatAt: new Date(nowMs).toISOString(),
    status: facts.status,
    workspaceFolder: facts.workspaceFolder,
    workspaceName: facts.workspaceName,
    activeFolder: facts.activeFolder,
    schedulerLeader: facts.schedulerLeader,
    libraryPath: facts.libraryPath,
    resultsPath: facts.resultsPath,
    costLast7Days: facts.costLast7Days,
    counts: {
      scheduled: series.filter((s) => s.enabled && !s.spent).length,
      running: runs.filter((r) => r.status === 'running').length,
      pending: runs.filter((r) => r.status === 'pending').length,
      missed: runs.filter((r) => r.status === 'missed').length,
      failedRecent: failedRecent.length
    },
    // Strictly future: `buildActivity` only lists an occurrence here once it is
    // past now, so a queued run whose time has been and gone cannot answer
    // "what fires next".
    nextRunAt: activity.upcoming[0]?.at,
    activeRuns: runs
      .filter((r) => r.status === 'running')
      .map((r) =>
        detail({
          seriesId: r.seriesId,
          planTitle: titleOf(r.seriesId),
          at: r.startedAt ?? r.scheduledAt,
          runId: r.id
        })
      )
      .sort((a, b) => a.at.localeCompare(b.at)),
    upcoming: upcoming.slice(0, MAX_LISTED),
    recent: recent.slice(0, MAX_LISTED),
    // Carried in their own lists rather than left to be filtered out of
    // `recent`: a run missed three days ago has fallen off the end of it, and
    // an unanswered missed run is the thing the board exists to surface.
    missed: recent.filter((e) => e.status === 'missed').slice(0, MAX_LISTED),
    failures: failedRecent
      .map((r) =>
        detail({
          seriesId: r.seriesId,
          planTitle: titleOf(r.seriesId),
          at: r.finishedAt ?? r.scheduledAt,
          runId: r.id
        })
      )
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, MAX_LISTED)
  };
}

/** A run whose series has been unscheduled or deleted still happened. */
const REMOVED_PLAN = 'Removed plan';

function titleLookup(series: readonly TaskSeries[]): (seriesId: string) => string {
  const byId = new Map(series.map((s) => [s.id, s]));
  return (seriesId) => {
    const found = byId.get(seriesId);
    return found ? found.fileName.replace(/\.md$/i, '') : REMOVED_PLAN;
  };
}

function withRunDetail(
  entry: { seriesId: string; planTitle: string; at: string; runId?: string },
  run: TaskRun | undefined
): DashboardEntry {
  const shaped: DashboardEntry = {
    seriesId: entry.seriesId,
    planTitle: entry.planTitle,
    at: entry.at
  };
  if (!run) {
    return shaped;
  }

  shaped.runId = run.id;
  shaped.status = run.status;
  shaped.attempt = run.attempt;
  if (run.costUsd !== undefined) {
    shaped.costUsd = run.costUsd;
  }
  if (run.lastError) {
    shaped.error = truncate(run.lastError, DASHBOARD_ERROR_MAX_CHARS);
  }
  return shaped;
}

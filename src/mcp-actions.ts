import * as fs from 'fs';
import * as library from './library';
import { readLock } from './lock';
import {
  planCwd,
  planSeriesOverrides,
  planTiming,
  QUEUED_NOTE,
  ScheduleWhen,
  schedulerIsLive,
  Verdict
} from './mcp-tools';
import { ChronosPaths, ensureRoot, resolveLinks } from './roots';
import { createSeries } from './series';
import { readState, updateState } from './state-file';
import { PermissionMode, TaskRun, TaskSeries } from './types';
import { isTaskName, listUnclaimed, PlanRequest, writeRequest } from './requests';

/**
 * The write actions every outside door shares.
 *
 * `mcp-server.ts` speaks stdio for one folder; `hub.ts` speaks HTTP for many.
 * Both used to carry their own copy of "resolve the plan, contain the cwd, check
 * the timing, build the series, write it" — the same thirty lines, which is
 * exactly the kind of pair that drifts. They live here once, as pure functions
 * of a `ChronosPaths`, so a rule tightened for one door is tightened for both,
 * and so the tests can drive them without a transport.
 *
 * Nothing here imports `vscode`. Every function takes the folder's paths rather
 * than reading a process-wide constant, which is what lets the hub call them for
 * eight folders from one process.
 */

///////////////////////////*Shapes*////////////////////////////

export interface ScheduleArgs extends ScheduleWhen {
  /** Plan file name, from the library. Never a path. */
  name: string;
  agent?: 'claude' | 'opencode' | 'codex';
  model?: string;
  cwd?: string;
  maxRetries?: number;
  /** Only honoured when `allowPermissionMode` is set — see `scheduleSeries`. */
  permissionMode?: string;
}

export interface ScheduleOptions {
  /** The manifest default, restated by the caller because settings live in VS Code. */
  maxRetries: number;
  /**
   * Whether `permissionMode` may be set at all. False for an agent-driven door
   * (`mcp-server.ts`), where a model must not raise its own permissions; true
   * for a door only the owner holds a token to (`hub.ts`).
   */
  allowPermissionMode: boolean;
}

const PERMISSION_MODES: readonly PermissionMode[] = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'dontAsk',
  'manual',
  'plan'
];

const refuse = <T>(reason: string): Verdict<T> => ({ ok: false, reason });

///////////////////////////*Reads*////////////////////////////

/** The view of a series an agent or a board gets. */
export function describeSeries(series: TaskSeries) {
  return {
    id: series.id,
    plan: series.fileName,
    nextRunAt: series.nextRunAt,
    recurrence: series.recurrence,
    enabled: series.enabled,
    spent: series.spent ?? false,
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

export function describeRun(run: TaskRun) {
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

/** `QUEUED_NOTE` when no window is watching this folder, otherwise undefined. */
export function queuedNote(paths: ChronosPaths, now: number = Date.now()): string | undefined {
  return schedulerIsLive(readLock(paths.lock), now) ? undefined : QUEUED_NOTE;
}

/**
 * One folder as a status row: live or not, what is running, what is next, how
 * many series sit in each state. What a board needs before it needs anything
 * else, computed from the files rather than from a window's memory so it is
 * the same answer for a folder with no window open.
 */
export function summarizeInstance(paths: ChronosPaths, now: number = Date.now()) {
  const lock = readLock(paths.lock);
  const live = schedulerIsLive(lock, now);
  const { state } = readState(paths.state);
  const byId = new Map(state.series.map((s) => [s.id, s]));

  const counts = { series: state.series.length, armed: 0, parked: 0, spent: 0, off: 0 };
  let next: TaskSeries | undefined;
  for (const s of state.series) {
    const kind = !s.enabled ? 'off' : s.spent ? 'spent' : s.chain ? 'parked' : 'armed';
    counts[kind]++;
    if (kind === 'armed') {
      const at = Date.parse(s.nextRunAt);
      if (!Number.isNaN(at) && (!next || at < Date.parse(next.nextRunAt))) {
        next = s;
      }
    }
  }

  const inFlight = state.runs.find((r) => r.status === 'running');
  const running = inFlight
    ? {
        runId: inFlight.id,
        plan: byId.get(inFlight.seriesId)?.fileName ?? inFlight.seriesId,
        startedAt: inFlight.startedAt ?? inFlight.scheduledAt,
        attempt: inFlight.attempt,
        engine: byId.get(inFlight.seriesId)?.agent ?? 'claude',
        model: byId.get(inFlight.seriesId)?.model ?? null
      }
    : null;

  let tasks = 0;
  try {
    tasks = library.listPlans(paths.tasks).length;
  } catch {
    // No inbox yet.
  }

  return {
    folder: paths.folder,
    live,
    lockAgeSec: lock ? Math.round((now - lock.heartbeatAt) / 1000) : null,
    running,
    next: next ? describeSeries(next) : null,
    counts,
    tasks,
    pendingRequests: listUnclaimed(paths.requests).length
  };
}

///////////////////////////*Writes*////////////////////////////

/** Called before every write, never before a read. */
export function ensureWritable(paths: ChronosPaths): ChronosPaths {
  ensureRoot(paths);
  return paths;
}

/** Captures a one-line task into the folder's inbox. Capture only; nothing runs. */
export function captureTask(paths: ChronosPaths, text: string): Verdict<library.PlanFile> {
  const clean = text.trim();
  if (!clean) {
    return refuse('A task needs some text.');
  }
  return { ok: true, value: library.createPlan(ensureWritable(paths).tasks, clean, `${clean}\n`) };
}

/**
 * Puts a plan on the schedule. Nothing is written until the call has survived
 * every check, so a refused call leaves an unconfigured folder untouched.
 */
export function scheduleSeries(
  paths: ChronosPaths,
  args: ScheduleArgs,
  options: ScheduleOptions
): Verdict<{ series: TaskSeries; queued?: string }> {
  let filePath: string;
  try {
    filePath = library.planPath(paths.plans, args.name);
  } catch {
    return refuse(`"${args.name}" is not a name in this library.`);
  }
  if (!fs.existsSync(filePath)) {
    return refuse(`There is no plan named "${args.name}" in this library. Call list_plans for the ones there are.`);
  }

  const where = args.cwd === undefined ? undefined : planCwd(args.cwd, paths.folder, resolveLinks);
  if (where && !where.ok) {
    return refuse(where.reason);
  }

  const timing = planTiming(args);
  if (!timing.ok) {
    return refuse(timing.reason);
  }

  // The permission gate. An agent's door refuses the key outright; the owner's
  // door validates it and applies it after the shared override check, which
  // would otherwise refuse it on the agent's behalf.
  let permissionMode: PermissionMode | undefined;
  if (args.permissionMode !== undefined) {
    if (!options.allowPermissionMode) {
      const check = planSeriesOverrides({ permissionMode: args.permissionMode });
      return refuse(check.ok ? 'permissionMode cannot be set here.' : check.reason);
    }
    if (!PERMISSION_MODES.includes(args.permissionMode as PermissionMode)) {
      return refuse(`permissionMode must be one of ${PERMISSION_MODES.join(', ')}.`);
    }
    permissionMode = args.permissionMode as PermissionMode;
  }

  const overrides = planSeriesOverrides({
    ...pick(args, ['agent', 'model', 'maxRetries']),
    ...(where?.ok ? { cwd: where.value } : {}),
    ...timing.value
  });
  if (!overrides.ok) {
    return refuse(overrides.reason);
  }

  const series = createSeries(
    filePath,
    { cwd: paths.folder, maxRetries: options.maxRetries },
    { ...overrides.value, ...(permissionMode ? { permissionMode } : {}) }
  );
  updateState(ensureWritable(paths).state, (current) => {
    current.series.push(series);
  });

  const queued = queuedNote(paths);
  return { ok: true, value: queued ? { series, queued } : { series } };
}

/**
 * Asks a live window on this folder to open a planning session for a task.
 * Returns the request as written plus whether anything is there to pick it up.
 */
export function requestPlan(
  paths: ChronosPaths,
  input: { task: string; series?: boolean; model?: string; source?: string }
): Verdict<{ request: PlanRequest; live: boolean; note: string }> {
  if (!isTaskName(input.task)) {
    return refuse('`task` must be a task file name from list_tasks, e.g. "fix-the-lock.md".');
  }
  let exists = false;
  try {
    exists = fs.existsSync(library.planPath(paths.tasks, input.task));
  } catch {
    exists = false;
  }
  if (!exists) {
    return refuse(`There is no task named "${input.task}" in this inbox.`);
  }

  ensureWritable(paths);
  const request = writeRequest(paths.requests, input);
  const live = schedulerIsLive(readLock(paths.lock));
  return {
    ok: true,
    value: {
      request,
      live,
      note: live
        ? 'A live window on this folder will open the planning session within a few seconds. Its questions arrive in list_questions.'
        : 'No window is open on this folder. The request is saved and a window will pick it up when one opens.'
    }
  };
}

///////////////////////////*Helpers*////////////////////////////

function pick<T extends object>(source: T, keys: readonly (keyof T)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      out[key as string] = source[key];
    }
  }
  return out;
}

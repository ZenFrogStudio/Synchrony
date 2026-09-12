import * as fs from 'fs';
import { chainPatches, spliceChain, wouldCycle } from './chain';
import { newRun } from './decide';
import { seriesEdit } from './edit';
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
import { SynchronyPaths, ensureRoot, resolveLinks } from './roots';
import { createSeries, newId, stampRepeatEnd } from './series';
import { readState, updateState } from './state-file';
import { nowUtc } from './time';
import { MAX_CHAIN_DELAY_MINUTES, PermissionMode, TaskRun, TaskSeries } from './types';
import { isTaskName, listUnclaimed, PlanRequest, writeRequest } from './requests';

/**
 * The write actions every outside door shares.
 *
 * `mcp-server.ts` speaks stdio for one folder; `hub.ts` speaks HTTP for many.
 * Both used to carry their own copy of "resolve the plan, contain the cwd, check
 * the timing, build the series, write it" — the same thirty lines, which is
 * exactly the kind of pair that drifts. They live here once, as pure functions
 * of a `SynchronyPaths`, so a rule tightened for one door is tightened for both,
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
export function queuedNote(paths: SynchronyPaths, now: number = Date.now()): string | undefined {
  return schedulerIsLive(readLock(paths.lock), now) ? undefined : QUEUED_NOTE;
}

/**
 * One folder as a status row: live or not, what is running, what is next, how
 * many series sit in each state. What a board needs before it needs anything
 * else, computed from the files rather than from a window's memory so it is
 * the same answer for a folder with no window open.
 */
export function summarizeInstance(paths: SynchronyPaths, now: number = Date.now()) {
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

  const missedRuns = state.runs.filter((r) => r.status === 'missed').length;

  // Same rule as `Store.costLast7Days`, copied rather than shared: that class
  // reads its own in-memory state, and this reads a fresh file every call.
  const cutoff = now - 7 * 24 * 60 * 60_000;
  const costLast7Days = state.runs
    .filter((r) => r.costUsd !== undefined && r.finishedAt !== undefined)
    .filter((r) => Date.parse(r.finishedAt as string) >= cutoff)
    .reduce((sum, r) => sum + (r.costUsd ?? 0), 0);

  return {
    folder: paths.folder,
    live,
    lockAgeSec: lock ? Math.round((now - lock.heartbeatAt) / 1000) : null,
    running,
    next: next ? describeSeries(next) : null,
    counts,
    tasks,
    pendingRequests: listUnclaimed(paths.requests).length,
    missedRuns,
    costLast7Days
  };
}

///////////////////////////*Writes*////////////////////////////

/** Called before every write, never before a read. */
export function ensureWritable(paths: SynchronyPaths): SynchronyPaths {
  ensureRoot(paths);
  return paths;
}

/** Captures a one-line task into the folder's inbox. Capture only; nothing runs. */
export function captureTask(paths: SynchronyPaths, text: string): Verdict<library.PlanFile> {
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
  paths: SynchronyPaths,
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
  paths: SynchronyPaths,
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

/**
 * What "run now" tells the caller when a window is watching. Worded like
 * `QUEUED_NOTE` — a fact about what happens next, not a warning — because it is
 * true either way: the run is on disk, and the only question is how soon a
 * live scheduler notices it.
 */
const RUN_NOW_NOTE =
  'Queued. The desktop scheduler on this folder picks it up on its next tick, within about 30 seconds.';

/** A ceiling on a plan or task body. Mirrors the manager's own drop cap. */
const MAX_TEXT_BYTES = 1_000_000;

/**
 * Changes an existing series. Both doors reuse `seriesEdit`'s allowlist —
 * `agent`, `model` and `filePath` all leave this process eventually — and add
 * the one rule `seriesEdit` cannot check for itself: whether a `chain` link
 * names a series that exists and would not loop back on itself.
 */
export function editSeries(
  paths: SynchronyPaths,
  id: string,
  rawPatch: unknown,
  opts: { allowPermissionMode: boolean }
): Verdict<ReturnType<typeof describeSeries>> {
  const { state } = readState(paths.state);
  if (!state.series.some((s) => s.id === id)) {
    return refuse('No scheduled task has that id.');
  }

  const input =
    !opts.allowPermissionMode && rawPatch && typeof rawPatch === 'object'
      ? omit(rawPatch as Record<string, unknown>, 'permissionMode')
      : rawPatch;

  // A rejected field is dropped rather than failing the whole call — the same
  // choice the manager makes for `schedulePlan`/`chainPlans`, because the
  // caller here is a person editing a task, not an agent that needs to be told
  // exactly what it could not do.
  const { patch } = seriesEdit(input);

  if (patch.chain) {
    const after = patch.chain.after;
    if (!state.series.some((s) => s.id === after)) {
      return refuse('No scheduled task has that id, so nothing can run after it.');
    }
    if (wouldCycle(state.series, id, after)) {
      return refuse('That would make a loop — the two tasks would each be waiting on the other.');
    }
  }

  let updated: TaskSeries | undefined;
  updateState(ensureWritable(paths).state, (current) => {
    const target = current.series.find((s) => s.id === id);
    if (target) {
      Object.assign(target, stampRepeatEnd(target, patch));
      updated = target;
    }
  });

  return updated
    ? { ok: true, value: describeSeries(updated) }
    : refuse('That task was removed while this call was in flight.');
}

/**
 * Drops a series and its run history, relinking anything chained after it onto
 * whatever it was itself waiting on. Lifted from the stdio server's
 * `unschedule` tool, which now calls this instead of carrying its own copy.
 */
export function removeSeries(paths: SynchronyPaths, id: string): Verdict<{ fileName: string }> {
  const { state } = readState(paths.state);
  const series = state.series.find((s) => s.id === id);
  if (!series) {
    return refuse('No scheduled task has that id.');
  }

  updateState(ensureWritable(paths).state, (current) => {
    // Before the removal, while the link being closed up is still readable —
    // the same order `Store.removeSeries` uses, for the same reason.
    const splices = spliceChain(current.series, id);
    current.series = current.series.filter((s) => s.id !== id);
    current.runs = current.runs.filter((r) => r.seriesId !== id);
    for (const { id: followerId, patch } of splices) {
      const follower = current.series.find((s) => s.id === followerId);
      if (follower) {
        Object.assign(follower, patch);
      }
    }
  });

  return { ok: true, value: { fileName: series.fileName } };
}

/**
 * Queues a manual run of a series right away — the "run now" a live window's
 * scheduler picks up on its next tick, which is also how a remote caller with
 * no window open at all gets a task to fire.
 */
export function runSeriesNow(
  paths: SynchronyPaths,
  seriesId: string,
  opts: { dismissRunId?: string } = {}
): Verdict<{ run: ReturnType<typeof describeRun>; note: string }> {
  const { state } = readState(paths.state);
  const series = state.series.find((s) => s.id === seriesId);
  if (!series) {
    return refuse('No scheduled task has that id.');
  }

  const run: TaskRun = { ...newRun(series, nowUtc(), 1, newId()), manual: true };
  updateState(ensureWritable(paths).state, (current) => {
    if (opts.dismissRunId) {
      current.runs = current.runs.filter((r) => r.id !== opts.dismissRunId);
    }
    current.runs.push(run);
  });

  return { ok: true, value: { run: describeRun(run), note: queuedNote(paths) ?? RUN_NOW_NOTE } };
}

/** Re-runs whatever series a past run belongs to, right away. */
export function rerunRun(
  paths: SynchronyPaths,
  runId: string
): Verdict<{ run: ReturnType<typeof describeRun>; note: string }> {
  const { state } = readState(paths.state);
  const run = state.runs.find((r) => r.id === runId);
  if (!run) {
    return refuse('No run has that id.');
  }
  if (!state.series.some((s) => s.id === run.seriesId)) {
    return refuse('That run belongs to a plan that is no longer scheduled.');
  }
  return runSeriesNow(paths, run.seriesId);
}

/** Drops one run from the history. Refused while it is still in flight. */
export function dismissRun(paths: SynchronyPaths, runId: string): Verdict<{ id: string }> {
  const { state } = readState(paths.state);
  const run = state.runs.find((r) => r.id === runId);
  if (!run) {
    return refuse('No run has that id.');
  }
  if (run.status === 'running') {
    return refuse('That run is in progress and cannot be dismissed.');
  }

  updateState(ensureWritable(paths).state, (current) => {
    current.runs = current.runs.filter((r) => r.id !== runId);
  });

  return { ok: true, value: { id: runId } };
}

///////////////////////////*Plan library*////////////////////////////

export function createPlanAction(paths: SynchronyPaths, title: string, body?: string): Verdict<library.PlanFile> {
  const clean = typeof title === 'string' ? title.trim() : '';
  if (!clean) {
    return refuse('Give the plan a name.');
  }
  return { ok: true, value: library.createPlan(ensureWritable(paths).plans, clean, body) };
}

/** Mirrors the manager's own drop cap: a plan is a prompt, not a data dump. */
export function savePlanAction(paths: SynchronyPaths, name: string, text: string): Verdict<void> {
  if (typeof text !== 'string' || text.length > MAX_TEXT_BYTES) {
    return refuse(`A plan cannot be larger than ${MAX_TEXT_BYTES.toLocaleString()} characters.`);
  }
  try {
    library.writePlan(ensureWritable(paths).plans, name, text);
  } catch {
    return refuse(`"${name}" is not a name in this library.`);
  }
  return { ok: true, value: undefined };
}

/**
 * Renames a plan file and repoints every series that pointed at its old path,
 * in the one `updateState` — mirroring `Manager.renamePlan` plus
 * `Manager.repointSeries`, which do the same two things as two separate writes
 * because the manager already holds its state in memory.
 */
export function renamePlanAction(
  paths: SynchronyPaths,
  name: string,
  newTitle: string
): Verdict<library.PlanFile> {
  const clean = typeof newTitle === 'string' ? newTitle.trim() : '';
  if (!clean) {
    return refuse('Give the plan a name.');
  }
  let before: string;
  try {
    before = library.planPath(paths.plans, name);
  } catch {
    return refuse(`"${name}" is not a name in this library.`);
  }
  if (!fs.existsSync(before)) {
    return refuse(`There is no plan named "${name}" in this library.`);
  }

  const plan = library.renamePlan(paths.plans, name, clean);

  updateState(ensureWritable(paths).state, (current) => {
    for (const series of current.series) {
      if (library.samePath(series.filePath, before)) {
        series.filePath = plan.filePath;
        series.fileName = plan.name;
      }
    }
  });

  return { ok: true, value: plan };
}

/**
 * Archives a plan file and, first, drops every series pointing at it —
 * splicing each one out of any chain it sits in, the same as
 * `Manager.archivePlan` calling `Store.removeSeries` per series before moving
 * the file, folded into one `updateState` since nothing here holds a live copy
 * of the state to act on between the two.
 */
export function archivePlanAction(paths: SynchronyPaths, name: string): Verdict<library.PlanFile> {
  let filePath: string;
  try {
    filePath = library.planPath(paths.plans, name);
  } catch {
    return refuse(`"${name}" is not a name in this library.`);
  }
  if (!fs.existsSync(filePath)) {
    return refuse(`There is no plan named "${name}" in this library.`);
  }

  updateState(ensureWritable(paths).state, (current) => {
    const pointing = current.series.filter((s) => library.samePath(s.filePath, filePath));
    for (const series of pointing) {
      const splices = spliceChain(current.series, series.id);
      current.series = current.series.filter((s) => s.id !== series.id);
      current.runs = current.runs.filter((r) => r.seriesId !== series.id);
      for (const { id: followerId, patch } of splices) {
        const follower = current.series.find((s) => s.id === followerId);
        if (follower) {
          Object.assign(follower, patch);
        }
      }
    }
  });

  return { ok: true, value: library.archivePlan(paths.plans, paths.archivedPlans, name) };
}

///////////////////////////*Task inbox*////////////////////////////

/** Mirrors `savePlanAction`'s cap: a task file is Markdown, not an upload. */
export function editTaskAction(paths: SynchronyPaths, name: string, text: string): Verdict<void> {
  if (typeof text !== 'string' || text.length > MAX_TEXT_BYTES) {
    return refuse(`A task cannot be larger than ${MAX_TEXT_BYTES.toLocaleString()} characters.`);
  }
  try {
    library.writePlan(ensureWritable(paths).tasks, name, text);
  } catch {
    return refuse(`"${name}" is not a name in this inbox.`);
  }
  return { ok: true, value: undefined };
}

export function deleteTaskAction(paths: SynchronyPaths, name: string): Verdict<library.PlanFile> {
  try {
    return {
      ok: true,
      value: library.archivePlan(ensureWritable(paths).tasks, paths.archivedTasks, name)
    };
  } catch {
    return refuse(`"${name}" is not a name in this inbox.`);
  }
}

/**
 * Imports an inbox task into the plan library and fires it right away, in
 * `auto` mode, `spent` so it never fires again on its own — mirroring
 * `TaskView.runTask`. The one thing this cannot mirror: that method also
 * clears the task from the inbox once its run lands, through a link held only
 * in that view's own memory. There is no such link here, so the task stays in
 * the inbox and the returned note says so.
 */
export function runTaskAction(
  paths: SynchronyPaths,
  name: string,
  opts: { model?: string } = {}
): Verdict<{ series: ReturnType<typeof describeSeries>; note: string }> {
  let taskPath: string;
  try {
    taskPath = library.planPath(paths.tasks, name);
  } catch {
    return refuse(`"${name}" is not a name in this inbox.`);
  }
  if (!fs.existsSync(taskPath)) {
    return refuse(`There is no task named "${name}" in this inbox.`);
  }

  const written = ensureWritable(paths);
  const plan = library.importFile(written.plans, taskPath);
  const series = createSeries(
    plan.filePath,
    { cwd: paths.folder, maxRetries: 0 },
    { permissionMode: 'auto', model: opts.model || undefined, spent: true }
  );
  const run: TaskRun = { ...newRun(series, nowUtc(), 1, newId()), manual: true };

  updateState(written.state, (current) => {
    current.series.push(series);
    current.runs.push(run);
  });

  const note =
    `${queuedNote(paths) ?? RUN_NOW_NOTE} "${name}" stays in the inbox — Synchrony only clears it ` +
    'automatically when it is run from the Tasks panel.';
  return { ok: true, value: { series: describeSeries(series), note } };
}

///////////////////////////*Chains*////////////////////////////

export interface ChainPlansArgs {
  names: string[];
  startIso: string;
  gapMinutes: number;
  stopOnFailure: boolean;
  agent?: string;
  model?: string;
  permissionMode?: string;
}

/**
 * Links plans to run one after another, minting a series for any name that
 * does not already have one and applying every link in a single write. Ports
 * `Manager.chainPlans`'s validation faithfully — see that method for why each
 * rule exists.
 */
export function chainPlansAction(
  paths: SynchronyPaths,
  args: ChainPlansArgs,
  opts: { maxRetries: number }
): Verdict<{ series: ReturnType<typeof describeSeries>[] }> {
  const names = Array.isArray(args.names) ? args.names.filter((n): n is string => typeof n === 'string') : [];
  const start = Date.parse(args.startIso);

  if (names.length < 2) {
    return refuse('A chain needs at least two plans.');
  }
  if (new Set(names).size !== names.length) {
    return refuse('A plan can only be in a chain once.');
  }
  if (Number.isNaN(start)) {
    return refuse('That start time is not a date.');
  }
  if (
    !Number.isInteger(args.gapMinutes) ||
    args.gapMinutes < 0 ||
    args.gapMinutes > MAX_CHAIN_DELAY_MINUTES
  ) {
    return refuse(`The gap between plans must be 0 to ${MAX_CHAIN_DELAY_MINUTES} minutes.`);
  }

  // Through `seriesEdit` rather than taken on trust, for the same reason
  // `Manager.chainPlans` runs it through there: `model` becomes an argv entry
  // for a shell-invoked spawn and `agent` chooses which executable that spawn
  // runs. An absent key is still visited and clears the field.
  const { patch: setup } = seriesEdit({
    agent: args.agent,
    model: args.model,
    permissionMode: args.permissionMode
  });

  const filePaths: string[] = [];
  for (const name of names) {
    let filePath: string;
    try {
      filePath = library.planPath(paths.plans, name);
    } catch {
      return refuse(`"${name}" is not a name in this library.`);
    }
    if (!fs.existsSync(filePath)) {
      return refuse(`${library.titleOf(name)} is no longer in the library.`);
    }
    filePaths.push(filePath);
  }

  // Every plan gets its series first, so the links below can name real ids —
  // an existing series for that file is reused, matching the manager's rule
  // that a plan already on the schedule keeps its history rather than getting
  // a second series minted against the same file.
  const { state } = readState(paths.state);
  const ids: string[] = [];
  const minted: TaskSeries[] = [];
  for (const filePath of filePaths) {
    const existing =
      state.series.find((s) => library.samePath(s.filePath, filePath)) ??
      minted.find((s) => library.samePath(s.filePath, filePath));
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const series = createSeries(filePath, { cwd: paths.folder, maxRetries: opts.maxRetries });
    minted.push(series);
    ids.push(series.id);
  }

  const patches = chainPatches(
    ids,
    new Date(start).toISOString(),
    args.gapMinutes,
    args.stopOnFailure === true,
    setup
  );

  const result: TaskSeries[] = [];
  updateState(ensureWritable(paths).state, (current) => {
    current.series.push(...minted);
    for (const { id, patch } of patches) {
      const target = current.series.find((s) => s.id === id);
      if (target) {
        Object.assign(target, stampRepeatEnd(target, patch));
      }
    }
    for (const id of ids) {
      const found = current.series.find((s) => s.id === id);
      if (found) {
        result.push(found);
      }
    }
  });

  return { ok: true, value: { series: result.map(describeSeries) } };
}

///////////////////////////*Helpers*////////////////////////////

/** Shallow-omits one key without mutating the source. */
function omit(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = source;
  return rest;
}

function pick<T extends object>(source: T, keys: readonly (keyof T)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      out[key as string] = source[key];
    }
  }
  return out;
}

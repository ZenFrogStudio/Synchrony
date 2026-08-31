import { armings } from './chain';
import { advancePast, computeNextRun } from './recurrence';
import { MissedReason, TaskRun, TaskSeries } from './types';

/**
 * The scheduler's tick decision, as a pure function. No `vscode`, no store, no
 * clock, no I/O — inputs in, actions out — so every rule below is directly
 * testable by the plain Node runner.
 *
 * `Scheduler` supplies the clock and applies the actions. This is the
 * functional core; the scheduler is the imperative shell.
 */

export type Action =
  | { kind: 'addRun'; run: TaskRun }
  | { kind: 'updateSeries'; id: string; patch: Partial<TaskSeries> }
  | { kind: 'updateRun'; id: string; patch: Partial<TaskRun> }
  | { kind: 'removeRun'; id: string }
  | { kind: 'start'; series: TaskSeries; run: TaskRun }
  /** Due, but held back for capacity. Reported so the next tick knows it was us. */
  | { kind: 'defer'; runId: string }
  | { kind: 'announceMissed'; count: number; reason: MissedReason }
  /** A repeat rule that cannot produce an occurrence. Paired with a pause. */
  | { kind: 'announceBroken'; fileName: string; problem: string };

export interface DecideInput {
  series: readonly TaskSeries[];
  runs: readonly TaskRun[];
  /** Epoch ms. */
  now: number;
  graceMs: number;
  /** Only ever shapes the wording of the missed notification. */
  reason: MissedReason;
  isSeriesRunning: (seriesId: string) => boolean;
  freeSlots: number;
  /**
   * Whether a live scheduler already held this run back on an earlier tick.
   *
   * The grace window exists to catch runs nothing was watching — the editor was
   * closed, the machine was asleep. A run this scheduler queued for capacity is
   * the opposite case: it is waiting, on a machine demonstrably awake, because
   * we told it to. Judging it against the same window marks it missed for our
   * own doing, and reports the reason as a suspend that never happened.
   */
  wasDeferred: (runId: string) => boolean;
  /** Injected so decisions stay deterministic under test. */
  newId: () => string;
}

export function newRun(
  series: TaskSeries,
  scheduledAt: string,
  attempt: number,
  id: string
): TaskRun {
  return { id, seriesId: series.id, scheduledAt, status: 'pending', attempt };
}

export function decide(input: DecideInput): Action[] {
  const { now, graceMs, reason } = input;
  const nowIso = new Date(now).toISOString();
  const actions: Action[] = [];

  // ---- 0. Arm the plans whose turn in a chain has come ----

  // Folded into a local copy of the list rather than only reported, so a plan
  // armed on this tick is due on this tick — the same reason a run materialised
  // below can start without waiting for the next one.
  const armed = armings(input.series, input.runs, now);
  actions.push(...armed);
  const current = applyPatches(input.series, armed);

  const seriesById = new Map(current.map((s) => [s.id, s]));

  let missedCount = 0;

  // Runs materialised below join this list, so an occurrence that comes due can
  // still start within the same tick rather than waiting for the next one.
  const candidates = input.runs.filter((r) => r.status === 'pending').slice();

  // ---- 1. Turn due occurrences into runs ----

  for (const series of current) {
    // `spent` retires a fired one-shot; `enabled` is the user's pause. Both
    // stop new occurrences, and only the second stops queued ones (below).
    if (!series.enabled || series.spent) {
      continue;
    }

    const overdue = now - Date.parse(series.nextRunAt);
    if (overdue < 0) {
      continue;
    }

    // A recurrence with no days, or a time that is not a wall clock, makes
    // `computeNextRun` throw. Caught per series and resolved before anything is
    // pushed: an escape from here aborts the whole tick, so one unusable rule
    // would silently stop every other task in the list from ever running.
    let advance: Partial<TaskSeries>;
    let run: TaskRun;
    try {
      advance = advanceOf(series, now);
      run =
        overdue <= graceMs
          ? newRun(series, series.nextRunAt, 1, input.newId())
          : missedRun(series, reason, now, nowIso, input.newId());
    } catch (err) {
      // Permanent, like a missing plan file: retrying throws identically. Pause
      // it so the tick stops tripping over it, and say so.
      actions.push({ kind: 'updateSeries', id: series.id, patch: { enabled: false } });
      actions.push({
        kind: 'announceBroken',
        fileName: series.fileName,
        problem: err instanceof Error ? err.message : String(err)
      });
      continue;
    }

    actions.push({ kind: 'addRun', run });
    actions.push({ kind: 'updateSeries', id: series.id, patch: advance });

    if (run.status === 'missed') {
      missedCount++;
    } else {
      candidates.push(run);
    }
  }

  // ---- 2. Start what is due, retries included ----

  let slots = input.freeSlots;
  const starting = new Set<string>();

  for (const run of [...candidates].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))) {
    const overdue = now - Date.parse(run.scheduledAt);
    if (overdue < 0) {
      continue;
    }

    const series = seriesById.get(run.seriesId);
    if (!series) {
      actions.push({ kind: 'removeRun', id: run.id });
      continue;
    }

    if (overdue > graceMs && !input.wasDeferred(run.id)) {
      actions.push({
        kind: 'updateRun',
        id: run.id,
        patch: { status: 'missed', missedAt: nowIso, missedReason: reason }
      });
      missedCount++;
      continue;
    }

    // Pausing a series stops its queued retries too. "Run now" is the deliberate
    // exception: it exists precisely to fire a series that is not scheduled.
    if (!series.enabled && !run.manual) {
      continue;
    }

    // Overlap guard (never stack a second run on one series) and the
    // concurrency gate. Both mean "wait", so both defer rather than break: a
    // run left unreported here would age out of the grace window above and be
    // marked missed on a later tick.
    if (input.isSeriesRunning(series.id) || starting.has(series.id) || slots <= 0) {
      actions.push({ kind: 'defer', runId: run.id });
      continue;
    }

    actions.push({ kind: 'start', series, run });
    starting.add(series.id);
    slots--;
  }

  if (missedCount > 0) {
    actions.push({ kind: 'announceMissed', count: missedCount, reason });
  }

  return actions;
}

/**
 * The list as the rest of the tick should see it, with the arming patches from
 * step 0 folded in. Copies rather than edits: the input is the store's own
 * snapshot, and every change to it belongs in an action.
 */
function applyPatches(series: readonly TaskSeries[], actions: readonly Action[]): TaskSeries[] {
  const patches = new Map<string, Partial<TaskSeries>>();
  for (const action of actions) {
    if (action.kind === 'updateSeries') {
      patches.set(action.id, { ...patches.get(action.id), ...action.patch });
    }
  }
  return patches.size ? series.map((s) => ({ ...s, ...patches.get(s.id) })) : [...series];
}

/** Where a series goes after its current occurrence is consumed. */
function advanceOf(series: TaskSeries, now: number): Partial<TaskSeries> {
  if (!series.recurrence) {
    return { spent: true };
  }
  return { nextRunAt: computeNextRun(series.recurrence, new Date(now)).toISOString() };
}

/**
 * One missed record per series per catch-up. A week-long outage should produce
 * a single decision, not seven notifications.
 */
function missedRun(
  series: TaskSeries,
  reason: MissedReason,
  now: number,
  nowIso: string,
  id: string
): TaskRun {
  const base: TaskRun = {
    ...newRun(series, series.nextRunAt, 1, id),
    status: 'missed',
    missedAt: nowIso,
    missedReason: reason
  };

  if (!series.recurrence) {
    return base;
  }

  const { skipped } = advancePast(series.recurrence, new Date(series.nextRunAt), new Date(now));
  return { ...base, missedCount: skipped + 1 };
}

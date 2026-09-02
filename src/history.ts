import {
  MAX_MISSED_RUNS,
  MAX_RECENT_RUNS,
  MAX_SPENT_SERIES,
  TaskRun,
  TaskSeries,
  isFinished
} from './types';

/**
 * How much run history is kept. Pure — no `vscode`, no store — because this is
 * the one place Chronos deletes something the user might still want, and that
 * rule should be a test rather than a hope.
 *
 * The store is one JSON file rewritten on every change, so it cannot grow
 * forever: a daily series left running for a year is 365 finished runs, and a
 * catch-up decision the user never answers is a missed run that nothing else
 * will ever clear.
 */

/**
 * When a run last mattered. A missed run has no `finishedAt`, only a `missedAt`;
 * a run still going has neither, so it falls back to when it started.
 *
 * Exported because `buildActivity` orders the Runs panel by the same rule, and
 * two definitions of "newest first" would drift apart. Pruning is unaffected by
 * the `startedAt` step: it only ever weighs finished and missed runs, and both
 * of those always carry one of the two earlier fields.
 */
export const recency = (run: TaskRun): string =>
  run.finishedAt ?? run.missedAt ?? run.startedAt ?? run.scheduledAt;

/**
 * Caps history, newest first.
 *
 * Finished and missed runs are capped separately and on different limits: a
 * missed run is still waiting for a decision, so it outlives a completed one.
 * Pending and running runs are never dropped — they are still in flight, and
 * discarding one would cancel scheduled work without saying so.
 */
export function pruneRuns(runs: readonly TaskRun[]): TaskRun[] {
  const capped = keepNewest([...runs], (run) => isFinished(run.status), MAX_RECENT_RUNS, recency);
  return keepNewest(capped, (run) => run.status === 'missed', MAX_MISSED_RUNS, recency);
}

/**
 * Caps spent one-shot series, newest first.
 *
 * A fired one-shot is invisible once its plan file is archived: the manager
 * lists plan files, not retired series entries. Keeping only the newest hundred
 * removes schedule entries and destroys nothing else. The dropped series' run
 * records stay in history, where the Runs panel already labels them "Removed
 * plan"; archived plan files and transcripts stay on disk.
 *
 * Recurring series, unspent one-shots, chained plans and work still in flight
 * are never candidates.
 */
export function pruneSeries(
  series: readonly TaskSeries[],
  runs: readonly TaskRun[]
): TaskSeries[] {
  const runsBySeries = new Map<string, TaskRun[]>();
  for (const run of runs) {
    const own = runsBySeries.get(run.seriesId);
    if (own) {
      own.push(run);
    } else {
      runsBySeries.set(run.seriesId, [run]);
    }
  }

  const chainIds = new Set<string>();
  for (const s of series) {
    if (s.chain) {
      // Keep this local instead of importing `isInChain`: `chain.ts` imports
      // `recency` from this module, so importing it back would make a cycle.
      chainIds.add(s.id);
      chainIds.add(s.chain.after);
    }
  }

  const runsOf = (s: TaskSeries) => runsBySeries.get(s.id) ?? [];
  const spentOneShot = (s: TaskSeries) =>
    !s.recurrence &&
    s.spent === true &&
    !chainIds.has(s.id) &&
    jobState(runsOf(s)) !== 'in-flight';
  const seriesRecency = (s: TaskSeries) =>
    runsOf(s)
      .map(recency)
      .sort((a, b) => b.localeCompare(a))[0] ?? s.nextRunAt;

  return keepNewest([...series], spentOneShot, MAX_SPENT_SERIES, seriesRecency);
}

/**
 * Where a job stands, judged from its runs alone.
 *
 * `in-flight` covers the moment before the run record exists: the series is
 * written first and the run a tick later, and reading that gap as "finished"
 * would clear a task whose job had not started.
 */
export type JobState = 'in-flight' | 'completed' | 'stopped';

export function jobState(runs: readonly TaskRun[]): JobState {
  if (!runs.length || runs.some((r) => r.status === 'pending' || r.status === 'running')) {
    return 'in-flight';
  }
  return runs.some((r) => r.status === 'completed') ? 'completed' : 'stopped';
}

/** Keeps the newest `max` of the items `matches` selects, leaving the rest alone. */
function keepNewest<T extends { id: string }>(
  items: T[],
  matches: (item: T) => boolean,
  max: number,
  at: (item: T) => string
): T[] {
  const selected = items.filter(matches);
  if (selected.length <= max) {
    return items;
  }

  const keep = new Set(
    selected
      .sort((a, b) => at(b).localeCompare(at(a)))
      .slice(0, max)
      .map((item) => item.id)
  );

  return items.filter((item) => !matches(item) || keep.has(item.id));
}

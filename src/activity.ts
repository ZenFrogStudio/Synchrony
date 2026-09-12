import { recency } from './history';
import { TaskRun, TaskSeries } from './types';

/**
 * What Synchrony is about to do, and what it has already done, across every plan.
 *
 * Pure — no `vscode`, no store, no clock — because the ordering and the split
 * between "coming up" and "already happened" are the only real logic behind the
 * Runs panel, and logic buried in webview JS cannot be tested by the plain Node
 * runner. `Manager.post()` supplies the clock; this decides the shape.
 */

export interface ActivityEntry {
  seriesId: string;
  /** Plan name for display — a panel row has to say which plan it belongs to. */
  planTitle: string;
  /** ISO 8601 UTC. What orders the entry. */
  at: string;
  /** Absent means a future occurrence that is not a run record yet. */
  runId?: string;
}

/** A run whose series has been unscheduled or deleted still happened. */
const REMOVED_PLAN = 'Removed plan';

export function buildActivity(
  series: readonly TaskSeries[],
  runs: readonly TaskRun[],
  nowMs: number
): { upcoming: ActivityEntry[]; recent: ActivityEntry[] } {
  const seriesById = new Map(series.map((s) => [s.id, s]));
  const titleOf = (seriesId: string): string => {
    const found = seriesById.get(seriesId);
    return found ? found.fileName.replace(/\.md$/i, '') : REMOVED_PLAN;
  };

  // Only occurrences that already exist as records, plus the one occurrence each
  // series is actually pointed at. A multi-day expansion of a recurrence rule
  // would be a prediction, and this panel is a record of work.
  const upcoming: ActivityEntry[] = series
    .filter((s) => s.enabled && !s.spent && Date.parse(s.nextRunAt) > nowMs)
    .map((s) => ({ seriesId: s.id, planTitle: titleOf(s.id), at: s.nextRunAt }));

  const recent: ActivityEntry[] = [];

  for (const run of runs) {
    // A `pending` run is normally due now and waiting for a slot; the exception
    // is a retry, which the scheduler queues minutes or hours ahead.
    const queuedAhead = run.status === 'pending' && Date.parse(run.scheduledAt) > nowMs;
    const entry: ActivityEntry = {
      seriesId: run.seriesId,
      planTitle: titleOf(run.seriesId),
      at: queuedAhead ? run.scheduledAt : recency(run),
      runId: run.id
    };
    (queuedAhead ? upcoming : recent).push(entry);
  }

  upcoming.sort((a, b) => a.at.localeCompare(b.at));
  recent.sort((a, b) => b.at.localeCompare(a.at));

  return { upcoming, recent };
}

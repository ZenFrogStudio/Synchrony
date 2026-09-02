import * as path from 'path';
import { downstream } from './chain';
import * as library from './library';
import { TaskRun, TaskSeries } from './types';

////////////////////////////*Scope*//////////////////////////////

/* A plan that has run is finished with the library. A one-shot has no future
once it has completed, so leaving its file in `.chronos/plans` fills the folder
with plans that will never fire again — and makes the list in the manager and the
folder in Explorer disagree about what the library holds.

//Steps to completion:

  //Pick out the series that are truly done — a one-shot, something completed,
    and nothing queued or in flight that would still need the file;
  //Group them by the file they point at, since two series can share one plan,
    and only move a file every one of its series is finished with;
  //Move the file into `.chronos/archive/plans` and repoint the series at the
    copy, marking them spent so an untaken occurrence cannot fire from there;
  //Keep the run history exactly where it is, so the Runs panel still names the
    plan and still links its transcript;
  //Report what moved, so the caller can log it.*/

/**
 * Just enough of `Store` to retire a plan. Structural rather than the real class
 * so this module stays free of `vscode` and the tests can hand it a plain object,
 * the same arrangement `consolidate.ts` uses.
 */
export interface RetireStore {
  getSeries(): readonly TaskSeries[];
  getRuns(): readonly TaskRun[];
  updateSeries(id: string, patch: Partial<TaskSeries>): Promise<void>;
}

export interface RetirementReport {
  /** Plans moved out, and where they landed. */
  archived: { planName: string; archivedAs: string }[];
}

/**
 * The series that have nothing left to do.
 *
 * A recurring plan always has a next time, so it never leaves the library. A
 * failed or cancelled one-shot stays too: it is there to be fixed and run again,
 * and it has to be visible to be fixable. Only a completed one is finished.
 *
 * The pending/running guard is the important one. A failed run queues a retry
 * an hour out, and that retry needs the file — archiving between the failure and
 * the retry would pull the plan out from under it.
 *
 * A plan that has *stopped* repeating stays too, until it has run again. The
 * completed runs behind it were made under a rule it no longer has, so counting
 * them would archive it the moment Repeat was switched to Once — with the
 * one-shot occurrence the user just set still waiting to fire.
 *
 * A chain retires as a unit, once every link is done. Otherwise its plans would
 * leave the library one at a time as the chain worked through them, with the
 * plans still to run naming a predecessor no longer in the list.
 */
export function retirable(
  series: readonly TaskSeries[],
  runs: readonly TaskRun[]
): TaskSeries[] {
  return series.filter((s) => {
    if (s.recurrence) {
      return false;
    }
    const own = runs.filter((r) => r.seriesId === s.id);
    if (own.some((r) => r.status === 'pending' || r.status === 'running')) {
      return false;
    }
    if (chainStillRunning(series, runs, s)) {
      return false;
    }
    return own.some((r) => r.status === 'completed' && ranSinceItStoppedRepeating(s, r));
  });
}

/**
 * Whether anything behind this plan in a chain has yet to have its turn. A link
 * switched off does not count: a chain stopped by a failure is not going to
 * reach it, so the plans that did run are free to leave.
 */
function chainStillRunning(
  series: readonly TaskSeries[],
  runs: readonly TaskRun[],
  s: TaskSeries
): boolean {
  return downstream(series, s.id).some((follower) => {
    if (!follower.enabled) {
      return false;
    }
    const own = runs.filter((r) => r.seriesId === follower.id);
    return (
      own.some((r) => r.status === 'pending' || r.status === 'running') ||
      !own.some((r) => r.status === 'completed')
    );
  });
}

/**
 * Whether a completed run counts as the one-shot's own run. A series that has
 * never repeated has nothing to compare against, so every completed run counts —
 * which is the ordinary case and keeps today's behaviour for it. A run with no
 * start time cannot be placed either side of the change and is treated as
 * older: a plan wrongly kept is a row in a list, a plan wrongly archived is one
 * the user has to go looking for.
 */
function ranSinceItStoppedRepeating(series: TaskSeries, run: TaskRun): boolean {
  if (!series.repeatEndedAt) {
    return true;
  }
  const ended = Date.parse(series.repeatEndedAt);
  if (Number.isNaN(ended)) {
    return true;
  }
  // `startedAt` rather than `finishedAt`, so a rule removed while a run was in
  // flight does not archive the plan on the strength of that run.
  const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
  if (Number.isNaN(started)) {
    return false;
  }
  return started >= ended;
}

/**
 * Moves every plan that has run out of the library. Idempotent: a series already
 * pointing into the archive fails the "still in the library" test below, so a
 * second pass finds nothing and reports nothing.
 */
export async function retireCompletedPlans(
  store: RetireStore,
  plansDir: string,
  archiveDir: string
): Promise<RetirementReport> {
  const report: RetirementReport = { archived: [] };

  const everySeries = store.getSeries();
  const done = retirable(everySeries, store.getRuns()).filter((s) =>
    library.isInside(plansDir, s.filePath)
  );

  // Two series can be scheduled against one plan file. Grouped by the file
  // rather than handled per series, so one move repoints both of them.
  const groups: { filePath: string; series: TaskSeries[] }[] = [];
  for (const series of done) {
    const group = groups.find((g) => library.samePath(g.filePath, series.filePath));
    if (group) {
      group.series.push(series);
    } else {
      groups.push({ filePath: series.filePath, series: [series] });
    }
  }

  for (const group of groups) {
    // Only when *every* series on the file is finished with it. Moving a plan
    // one schedule has run but another is still waiting on would leave that
    // second schedule pointing at nothing, and `consolidate` would then drop it.
    const sharing = everySeries.filter((s) => library.samePath(s.filePath, group.filePath));
    if (sharing.length !== group.series.length) {
      continue;
    }

    let archived: library.PlanFile;
    try {
      archived = library.archivePlan(plansDir, archiveDir, path.basename(group.filePath));
    } catch {
      // A plan locked by another process, or already gone, is not worth failing
      // the whole pass for — the same tolerance `listPlans` shows. It stays in
      // the library and the next finished run tries again.
      continue;
    }

    // No `await` between the move above and the repoint below, and this is why.
    // `Manager.restartWatching` runs `consolidate` on a debounce whenever the
    // library folder changes, and `consolidate` drops any series whose file has
    // gone — taking the run history with it. `archivePlan` is synchronous and
    // `Store.persist` reaches `renameSync` synchronously, so the only yields
    // here are to the microtask queue, which no timer callback can interleave
    // with. The watcher can never observe the half-done state.
    for (const series of group.series) {
      await store.updateSeries(series.id, {
        filePath: archived.filePath,
        fileName: archived.name,
        // The plan is leaving the library, so any occurrence it has not taken
        // yet must be consumed with it. Left live it would fire out of the
        // archive folder later, with no row anywhere to show for it.
        spent: true,
        // A retired plan is not waiting its turn — it has had it. Left linked,
        // the arming rule in `chain.ts` would re-arm it out of the archive the
        // next time the plan before it produced a finished run.
        chain: undefined
      });
    }

    report.archived.push({
      planName: path.basename(group.filePath),
      archivedAs: archived.name
    });
  }

  return report;
}

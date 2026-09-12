import * as fs from 'fs';
import * as path from 'path';
import * as library from './library';
import { TaskSeries } from './types';

////////////////////////////*Scope*//////////////////////////////

/* Make one kind of plan out of two. Synchrony used to schedule files where they
lay, anywhere on disk, which meant a second security model, a second watcher and
a second list in the UI for a distinction nobody asked for. This restores the
invariant every other module now assumes: every scheduled plan is a file in the
plan library, addressed by name.

//Steps to completion:

  //Refuse to run at all if the library folder cannot be read, so an unplugged
    drive is never mistaken for "every plan has been deleted";
  //Copy each scheduled plan that lives outside the library into it, sharing one
    copy between series that point at the same source file;
  //Repoint those series at the copy, leaving the working directory alone so the
    run still happens where it used to;
  //Leave an archived plan alone: a plan that has run is deliberately outside the
    library (see `retire.ts`), not a stray to be hoovered up — re-importing it
    would put it straight back in the list it just left;
  //Drop any series whose plan file no longer exists, along with its run history;
  //Report both, so the caller can log what was moved and what was discarded.*/

/**
 * Just enough of `Store` to move plans between paths. Structural rather than the
 * real class so this module stays free of `vscode` and the tests can hand it a
 * plain object.
 */
export interface SeriesStore {
  getSeries(): readonly TaskSeries[];
  updateSeries(id: string, patch: Partial<TaskSeries>): Promise<void>;
  removeSeries(id: string): Promise<void>;
}

export interface ConsolidationReport {
  /** Files copied in, newest name last. Empty on every run after the first. */
  imported: { sourcePath: string; planName: string }[];
  /** File names of schedules discarded because their plan file was gone. */
  droppedSchedules: string[];
  /** Why nothing was touched, when the library folder could not be read. */
  libraryUnreadable?: string;
}

/**
 * Brings every scheduled plan into the library. Idempotent by nature rather than
 * by a version gate: once step two has run, every path is already inside the
 * library and there is nothing left to find — which is why this needs no schema
 * bump and can safely run on every activation and on every library change.
 */
export async function consolidate(
  store: SeriesStore,
  dir: string,
  archiveDir: string
): Promise<ConsolidationReport> {
  const report: ConsolidationReport = { imported: [], droppedSchedules: [] };

  // The one guard that makes the prune below safe. A `synchrony.libraryPath` on an
  // unplugged drive or an offline share reads as "no files here", and pruning on
  // that would delete the user's whole schedule for a cable someone kicked out.
  try {
    fs.readdirSync(dir);
  } catch (err) {
    report.libraryUnreadable = String(err);
    return report;
  }

  // Two series scheduled against the same file share one copy — importing twice
  // would leave the user with two plans where they had one, and edits to either
  // would silently stop reaching the other run.
  const copies = new Map<string, library.PlanFile>();

  for (const series of [...store.getSeries()]) {
    // An archived plan is outside the library on purpose — `retire.ts` put it
    // there because it has run. Importing it back would undo that on the next
    // tick. Nothing else happens to it either: its file exists, so the prune
    // below leaves it be.
    if (
      library.isInside(dir, series.filePath) ||
      library.isInside(archiveDir, series.filePath) ||
      !fs.existsSync(series.filePath)
    ) {
      continue;
    }

    const source = path.resolve(series.filePath).toLowerCase();
    let copy = copies.get(source);
    if (!copy) {
      copy = library.importFile(dir, series.filePath);
      copies.set(source, copy);
      report.imported.push({ sourcePath: series.filePath, planName: copy.name });
    }

    // `cwd` is deliberately untouched. The plan has moved into global storage,
    // but the work it does still belongs to whichever project it ran against.
    await store.updateSeries(series.id, { filePath: copy.filePath, fileName: copy.name });
  }

  // Anything still pointing at a file that is not there would fire and fail on
  // schedule, forever. The series goes, and `removeSeries` takes its runs with it.
  for (const series of [...store.getSeries()]) {
    if (fs.existsSync(series.filePath)) {
      continue;
    }
    report.droppedSchedules.push(series.fileName);
    await store.removeSeries(series.id);
  }

  return report;
}

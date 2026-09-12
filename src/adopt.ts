import * as fs from 'fs';
import * as path from 'path';
import * as library from './library';
import { SynchronyPaths } from './roots';
import { emptyState } from './state-file';
import { SynchronyState } from './types';

/**
 * The one-time move from the old machine-wide storage into a folder.
 *
 * Synchrony used to keep a single library, task inbox and schedule in extension
 * storage, shared by every project. Making that data folder-specific after the
 * fact is guesswork — a plan named `nightly-audit.md` says nothing about which
 * repository it belongs to — so rather than split it up on a hunch, the whole
 * dataset moves into the first folder opened after the upgrade, and the user
 * moves individual plans on from there.
 *
 * Everything is *copied*. The old storage is left exactly as it was, which is
 * the same rule `library.importFile` follows for a user's own file: an upgrade
 * that deletes the only copy of a year of run history is not recoverable, and
 * disk is cheap.
 *
 * No `vscode` import, so the whole migration is testable against temp
 * directories.
 */

export interface LegacyPaths {
  plans: string;
  tasks: string;
  results: string;
}

/** The claim file, left in the old machine-wide storage. See `claimAdoption`. */
export const ADOPTION_MARKER = 'adopted.marker';

/**
 * Decides which single window gets to adopt, when several are open.
 *
 * The flag in `globalState` that guards adoption does not reach another window
 * the instant it is set, so two windows open at the moment the new build first
 * loads would both read "not adopted yet" and both copy the whole legacy
 * library — every plan *and its schedule* — into two different projects, which
 * then both start firing them. The old storage is the contended thing, so the
 * claim is staked there rather than in either folder.
 *
 * `wx` is create-or-fail in one operation, the same atomicity `state-file.ts`
 * relies on for its rename. Whichever window loses simply leaves the data alone.
 */
export function claimAdoption(legacyStorage: string): boolean {
  try {
    // VS Code creates global storage lazily, and a missing directory here would
    // read as "somebody else claimed it" and strand the data forever.
    fs.mkdirSync(legacyStorage, { recursive: true });
    fs.closeSync(fs.openSync(path.join(legacyStorage, ADOPTION_MARKER), 'wx'));
    return true;
  } catch {
    return false;
  }
}

export interface AdoptionReport {
  plans: number;
  tasks: number;
  /** Series whose plan file was found and repointed at the new copy. */
  repointed: number;
  runs: number;
  results: boolean;
}

export function adoptGlobal(
  legacy: LegacyPaths,
  next: SynchronyPaths,
  state: SynchronyState | undefined
): { state: SynchronyState; report: AdoptionReport } {
  const report: AdoptionReport = {
    plans: 0,
    tasks: 0,
    repointed: 0,
    runs: state?.runs.length ?? 0,
    results: false
  };

  // Old path (resolved, case-folded) -> the copy now in this folder's library.
  // Same shape as the map in `consolidate.ts`: two series scheduled against one
  // file must end up sharing one copy, or editing either stops reaching the
  // other run.
  const copies = new Map<string, library.PlanFile>();

  // A `synchrony.libraryPath` pointing at the folder we are adopting into makes
  // source and destination the same directory, and copying a directory into
  // itself would duplicate every plan under a `-2` name. There is nothing to
  // move in that case: the files are already where they belong.
  if (!sameDir(legacy.plans, next.plans)) {
    for (const plan of library.listPlans(legacy.plans)) {
      // The single door every outside file comes through — it slugs the name and
      // de-duplicates it, so a plan the target folder already has is not
      // overwritten.
      const copy = library.importFile(next.plans, plan.filePath);
      copies.set(key(plan.filePath), copy);
      report.plans++;
    }
  }

  if (!sameDir(legacy.tasks, next.tasks)) {
    for (const task of library.listPlans(legacy.tasks)) {
      library.importFile(next.tasks, task.filePath);
      report.tasks++;
    }
  }

  report.results = !sameDir(legacy.results, next.results) && copyTree(legacy.results, next.results);

  const adopted: SynchronyState = state ? { ...state, series: [...state.series] } : emptyState();

  adopted.series = adopted.series.map((series) => {
    const copy = copies.get(key(series.filePath));
    if (!copy) {
      // Its plan was not in the old library. `consolidate()` runs straight
      // after this and will either import the file or drop the schedule, so
      // there is nothing useful to decide here.
      return series;
    }
    report.repointed++;
    // `cwd` is deliberately untouched, for the reason `consolidate.ts` gives:
    // the plan has moved, but the work it does still belongs to whichever
    // project it ran against.
    return { ...series, filePath: copy.filePath, fileName: copy.name };
  });

  return { state: adopted, report };
}

/** Best-effort recursive copy. Returns whether there was anything to copy. */
function copyTree(from: string, to: string): boolean {
  if (!fs.existsSync(from)) {
    return false;
  }
  fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
  return true;
}

const key = (filePath: string): string => path.resolve(filePath).toLowerCase();

/** `samePath` folds case only where the filesystem does, which is what matters
 *  when the two sides came from a setting and from our own layout. */
const sameDir = (a: string, b: string): boolean => library.samePath(a, b);

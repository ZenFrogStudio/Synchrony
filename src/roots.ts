import * as fs from 'fs';
import * as path from 'path';

/**
 * Where one folder's Chronos data lives.
 *
 * Everything Chronos writes for a folder goes under a single `.chronos`
 * directory inside it: the schedule, the plan library, the task inbox, the run
 * transcripts and the raw logs. One root rather than a scattering of
 * configurable locations, so "what does Chronos know about this project?" is
 * answered by one `ls`, and moving a project moves its schedule with it.
 *
 * Pure path arithmetic plus one mkdir, like `results.ts` and `lock.ts` — no
 * `vscode` import, so the layout is testable against a temp directory.
 */

export const ROOT_DIR = '.chronos';

export interface ChronosPaths {
  /** The project folder Chronos is operating in. */
  folder: string;
  /** `<folder>/.chronos` — everything below is inside it. */
  root: string;
  /** Series and runs. Was `globalState` before the layout became per-folder. */
  state: string;
  /** Arbitrates which window schedules *this folder*. See `lock.ts`. */
  lock: string;
  plans: string;
  tasks: string;
  /** Staging for in-flight plan generation. Dot-prefixed so it is never listed. */
  pending: string;
  /**
   * Questions a planning session is waiting on an answer to. Not dot-prefixed,
   * unlike `.pending`: these are worth finding by hand when a session goes wrong.
   */
  questions: string;
  results: string;
  logs: string;
  /** Plans and tasks removed from the library. Kept, never pruned. */
  archive: string;
  archivedPlans: string;
  archivedTasks: string;
}

export function pathsFor(folder: string): ChronosPaths {
  const root = path.join(folder, ROOT_DIR);
  return {
    folder,
    root,
    state: path.join(root, 'state.json'),
    lock: path.join(root, 'scheduler.lock'),
    plans: path.join(root, 'plans'),
    tasks: path.join(root, 'tasks'),
    pending: path.join(root, '.pending'),
    questions: path.join(root, 'questions'),
    results: path.join(root, 'results'),
    logs: path.join(root, 'logs'),
    archive: path.join(root, 'archive'),
    archivedPlans: path.join(root, 'archive', 'plans'),
    archivedTasks: path.join(root, 'archive', 'tasks')
  };
}

/**
 * Creates the tree, and ignores the whole of it from git.
 *
 * The `.gitignore` goes *inside* the root rather than appending to the
 * project's own: editing a file the user owns to make our own feature work is
 * not ours to do, and a self-contained ignore file is removed by deleting the
 * folder. It is written only when absent, so a user who decides to track their
 * plans can simply edit it and keep that decision.
 *
 * Returns true when the root did not exist beforehand — the caller uses that to
 * decide whether a folder is new enough to want a starter plan.
 */
export function ensureRoot(paths: ChronosPaths): boolean {
  const created = fs.mkdirSync(paths.root, { recursive: true }) !== undefined;

  for (const dir of [paths.plans, paths.tasks, paths.questions, paths.results, paths.logs]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const ignore = path.join(paths.root, '.gitignore');
  if (!fs.existsSync(ignore)) {
    fs.writeFileSync(ignore, '*\n', 'utf8');
  }

  return created;
}

/**
 * The path with every symlink and junction along it resolved, as far as the
 * path actually exists.
 *
 * `fs.realpathSync` throws on a path that is not there, and a `cwd` naming a
 * folder about to be created is a legitimate thing to schedule — so the deepest
 * ancestor that does exist is resolved and the rest is re-appended. A path with
 * no existing ancestor at all (a drive that is not mounted) comes back merely
 * resolved, which is the safe answer: the caller's containment check then sees
 * it exactly as spelled.
 */
export function resolveLinks(target: string): string {
  let head = path.resolve(target);
  const tail: string[] = [];

  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) {
        return path.resolve(target);
      }
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

/** What one sweep of the staging area did. */
export interface SweepReport {
  /** How many staging folders were deleted. */
  removed: number;
  /** Folders left alone because a generated plan is still sitting in them. */
  kept: string[];
}

/**
 * Deletes staging folders no planning session will ever come back for.
 *
 * `TaskView.dispose` clears the sessions it knows about, but it only runs on a
 * clean shutdown — a crashed or reloaded window strands its folders whatever the
 * view does, which is how `.pending` fills up.
 *
 * Two gates, and both are load-bearing:
 *
 * - **Older than `maxAgeMs`.** A second window open on the same project may have
 *   a session in flight right now, and that session's staging folder is minutes
 *   old. Deleting it out from under the session breaks the write it is waiting
 *   for, so anything recent is left alone regardless of what is in it.
 * - **Holds no `.md`.** A stale folder with a plan in it holds generated work
 *   that never reached the library, and this is the only copy of it. It is kept
 *   and its path reported, so the user can rescue it by hand.
 *
 * Best-effort throughout, like `pruneLogs`: a `.pending` that was never created
 * reports nothing, and one unreadable folder does not abort the rest.
 */
export function sweepPending(dir: string, maxAgeMs = 24 * 60 * 60_000): SweepReport {
  const report: SweepReport = { removed: 0, kept: [] };
  const cutoff = Date.now() - maxAgeMs;

  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return report; // A folder that has never generated a plan has no `.pending`.
  }

  for (const name of names) {
    const session = path.join(dir, name);
    try {
      const stat = fs.statSync(session);
      if (!stat.isDirectory() || stat.mtimeMs >= cutoff) {
        continue;
      }
      if (fs.readdirSync(session).some((file) => file.toLowerCase().endsWith('.md'))) {
        report.kept.push(session);
        continue;
      }
      fs.rmSync(session, { recursive: true, force: true });
      report.removed++;
    } catch {
      // An unreadable folder is not worth abandoning the rest of the sweep for.
    }
  }

  return report;
}

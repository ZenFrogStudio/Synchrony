import * as fs from 'fs';
import * as path from 'path';

/**
 * The plan library: a folder of `.md` files. There is deliberately no index,
 * manifest or id table — an index is a second source of truth that drifts from
 * the filesystem the moment someone edits a file outside Synchrony. The directory
 * *is* the database.
 *
 * No `vscode` import, so every rule here is testable against a temp directory.
 */

export interface PlanFile {
  /** File name including extension, e.g. "refactor-auth.md". Identity. */
  name: string;
  /** Absolute path. */
  filePath: string;
  /** Display title — the name without its extension. */
  title: string;
  modifiedMs: number;
  sizeBytes: number;
}

const EXTENSION = '.md';

/** Reserved on Windows regardless of extension. */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

/**
 * Turns a user-typed title into a safe file name.
 *
 * Path separators and traversal segments are stripped rather than escaped: a
 * title is a label, and no label needs to address the filesystem. `isInside`
 * still checks the result, because defence in depth is cheap here and a written
 * file in the wrong place is not recoverable.
 */
export function toPlanFileName(title: string): string {
  const base = title
    .trim()
    .replace(new RegExp(`\\${EXTENSION}$`, 'i'), '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  const safe = !base || RESERVED.has(base) ? `plan-${base || 'untitled'}` : base;
  return `${safe}${EXTENSION}`;
}

/** How many words a generated plan name is allowed. */
const WORD_LIMIT = 3;

/**
 * The first few words of a title. A generated plan is named by a model, and a
 * model asked for three words will sometimes write nine — so the library is
 * kept scannable here rather than trusting the instruction that asked for it.
 *
 * Only ever applied to a name Synchrony generated. A title the user typed, or one
 * an external agent chose, is left whole.
 */
export function firstWords(title: string, count = WORD_LIMIT): string {
  const words = title
    .replace(new RegExp(`\\${EXTENSION}$`, 'i'), '')
    .split(/[^a-zA-Z0-9]+/)
    .filter((word) => word !== '');

  // Nothing word-shaped in it — hand the original on, so `toPlanFileName` gets
  // to apply its own `plan-untitled` fallback rather than being given ''.
  return words.length ? words.slice(0, count).join('-') : title;
}

/** Appends -2, -3 … until the name is free. */
export function uniqueName(existing: readonly string[], desired: string): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(desired.toLowerCase())) {
    return desired;
  }

  const stem = desired.slice(0, -EXTENSION.length);
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${EXTENSION}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

/** Whether `target` resolves to somewhere inside `dir`. */
export function isInside(dir: string, target: string): boolean {
  const root = path.resolve(dir);
  const resolved = path.resolve(target);
  if (resolved === root) {
    return false;
  }
  const rel = path.relative(root, resolved);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function isPlanFile(name: string): boolean {
  return path.extname(name).toLowerCase() === EXTENSION;
}

/**
 * A `text/uri-list` payload: one URI per line, `#` lines are comments.
 * Both the VS Code explorer and the OS shell hand drops over in this format,
 * and RFC 2483 says the separator is CRLF — but VS Code sends bare LF, so both
 * are accepted.
 */
export function parseUriList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * Whether two paths address the same file. Resolved first, so `..` segments and
 * mixed separators do not defeat the comparison.
 *
 * Case is folded only where the filesystem folds it. On Linux `Plan.md` and
 * `plan.md` are two different files, and treating them as one would let a caller
 * write to a file it did not name — the opposite of what the callers below want.
 * `ignoreCase` is a parameter rather than a bare `process.platform` check so both
 * branches are reachable from a test on either platform.
 */
export function samePath(a: string, b: string, ignoreCase = process.platform === 'win32'): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return ignoreCase ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export const titleOf = (name: string): string => name.slice(0, -path.extname(name).length);

/** A ceiling on a row that wraps over as many lines as it needs: long enough for
 *  a real task to show in full, short enough that pasting an essay into a task
 *  file cannot grow the row without bound. */
const TASK_LABEL_MAX = 300;

/**
 * How a task file reads as a tree row: every non-empty line of it, stripped of
 * the Markdown marks that make a heading or a bullet, and clipped.
 *
 * The file is the task — this only decides how it is displayed, so nothing here
 * is ever written back. A task grows extra lines once Claude has asked about it,
 * and those lines are part of the description, so the row shows them and wraps.
 * Blank lines are dropped, so paragraph gaps do not pad the row out.
 */
export function taskLabel(text: string): string {
  const joined = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)?/, '').trim())
    .filter((line) => line !== '')
    .join('\n');

  if (!joined) {
    return '(empty task)';
  }
  return joined.length > TASK_LABEL_MAX
    ? `${joined.slice(0, TASK_LABEL_MAX - 1).trimEnd()}…`
    : joined;
}

/**
 * Resolves a name inside the library, refusing anything that escapes it. Every
 * read and write goes through here, and so does every caller that needs a plan's
 * absolute path — scheduling it, opening it in an editor — because a name is the
 * only way the webview may address a plan, and a name must never reach the
 * filesystem unchecked.
 */
export function planPath(dir: string, name: string): string {
  const candidate = path.join(dir, path.basename(name));
  if (!isInside(dir, candidate) || !isPlanFile(candidate)) {
    throw new Error(`Refusing to touch a path outside the plan library: ${name}`);
  }
  return candidate;
}

/** Returns true when the library folder did not exist and was just created. */
export function ensureLibrary(dir: string): boolean {
  const created = fs.mkdirSync(dir, { recursive: true });
  return created !== undefined;
}

/**
 * A first-run plan, so the manager opens with something to look at and a safe
 * thing to try. Only ever written when the library is first created — deleting
 * it must not bring it back.
 */
export function seedLibrary(dir: string): void {
  createPlan(
    dir,
    'Hello Synchrony',
    [
      '# Hello Synchrony',
      '',
      'Reply with exactly the word `OK` and then stop.',
      '',
      'Do not create, edit, move or delete any files. Do not run any shell',
      'commands. This plan exists so you can confirm scheduling works before',
      'trusting Synchrony with something real.',
      ''
    ].join('\n')
  );
}

/** Newest first. Unreadable entries are skipped rather than failing the list. */
export function listPlans(dir: string): PlanFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const plans: PlanFile[] = [];
  for (const name of names) {
    if (!isPlanFile(name)) {
      continue;
    }
    const filePath = path.join(dir, name);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        continue;
      }
      plans.push({
        name,
        filePath,
        title: titleOf(name),
        modifiedMs: stat.mtimeMs,
        sizeBytes: stat.size
      });
    } catch {
      // A file removed mid-listing is not worth failing the whole view for.
    }
  }

  return plans.sort((a, b) => b.modifiedMs - a.modifiedMs);
}

function describe(dir: string, name: string): PlanFile {
  const filePath = planPath(dir, name);
  const stat = fs.statSync(filePath);
  return {
    name,
    filePath,
    title: titleOf(name),
    modifiedMs: stat.mtimeMs,
    sizeBytes: stat.size
  };
}

export function createPlan(dir: string, title: string, body?: string): PlanFile {
  ensureLibrary(dir);
  const name = uniqueName(
    listPlans(dir).map((p) => p.name),
    toPlanFileName(title)
  );
  const filePath = planPath(dir, name);
  fs.writeFileSync(filePath, body ?? starterBody(titleOf(name)), 'utf8');
  return describe(dir, name);
}

export function readPlan(dir: string, name: string): string {
  return fs.readFileSync(planPath(dir, name), 'utf8');
}

export function writePlan(dir: string, name: string, text: string): void {
  fs.writeFileSync(planPath(dir, name), text, 'utf8');
}

/**
 * Copies a file from anywhere on disk into the library, under a name derived
 * from its own. The source is read, never moved or linked — the user's file
 * stays exactly where it was, and the copy is what Synchrony goes on to schedule,
 * edit and run.
 *
 * This is the single door into the library for outside files: everything that
 * adds a plan (Import, a drop, right-click → Schedule, the one-time migration of
 * old external schedules) comes through here, which is what makes "every
 * scheduled plan is a library plan" true rather than merely intended.
 *
 * `title` overrides the name the copy is filed under; omitted, the source
 * file's own name is used, which is what an import or a drop wants.
 */
export function importFile(dir: string, sourcePath: string, title?: string): PlanFile {
  return createPlan(
    dir,
    title ?? path.basename(sourcePath, path.extname(sourcePath)),
    fs.readFileSync(sourcePath, 'utf8')
  );
}

/** Returns the plan under its new name, which may have been deduplicated. */
export function renamePlan(dir: string, name: string, newTitle: string): PlanFile {
  const from = planPath(dir, name);
  const desired = toPlanFileName(newTitle);

  if (desired.toLowerCase() === name.toLowerCase()) {
    return describe(dir, name);
  }

  const to = uniqueName(
    listPlans(dir).map((p) => p.name),
    desired
  );
  fs.renameSync(from, planPath(dir, to));
  return describe(dir, to);
}

export function duplicatePlan(dir: string, name: string): PlanFile {
  const copy = uniqueName(
    listPlans(dir).map((p) => p.name),
    `${titleOf(name)}-copy${EXTENSION}`
  );
  fs.copyFileSync(planPath(dir, name), planPath(dir, copy));
  return describe(dir, copy);
}

export function removePlan(dir: string, name: string): void {
  fs.unlinkSync(planPath(dir, name));
}

/**
 * Moves a file out of the library rather than unlinking it.
 *
 * Deleting is reachable from a hover-height button on a list row, and there is
 * no recycle bin behind `unlinkSync` and no undo behind the row — so the user's
 * writing survives the misclick, in a folder on disk they can open and re-import
 * from. Nothing is ever pruned from it: a plan the user wrote is worth more than
 * the bytes it costs to keep.
 *
 * A colliding name costs a suffix, never the archived copy already there.
 */
export function archivePlan(dir: string, archiveDir: string, name: string): PlanFile {
  const from = planPath(dir, name);
  fs.mkdirSync(archiveDir, { recursive: true });

  const to = uniqueName(
    listPlans(archiveDir).map((p) => p.name),
    path.basename(name)
  );
  const target = planPath(archiveDir, to);

  try {
    fs.renameSync(from, target);
  } catch {
    // A rename cannot cross a drive (EXDEV), and `synchrony.libraryPath` can put
    // the library on one while the archive stays under the folder's `.synchrony`.
    fs.copyFileSync(from, target);
    fs.unlinkSync(from);
  }

  return describe(archiveDir, to);
}

function starterBody(title: string): string {
  return `# ${title}\n\nDescribe what Claude should do when this plan runs.\n`;
}

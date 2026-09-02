import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ensureRoot, pathsFor, resolveLinks, ROOT_DIR, sweepPending } from '../src/roots';

let folder: string;

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chronos-root-'));
});

afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

describe('pathsFor', () => {
  it('should_place_every_artefact_under_a_dot_chronos_root', () => {
    const paths = pathsFor(folder);

    const root = path.join(folder, ROOT_DIR);
    assert.equal(paths.folder, folder);
    assert.equal(paths.root, root);
    assert.equal(paths.state, path.join(root, 'state.json'));
    assert.equal(paths.lock, path.join(root, 'scheduler.lock'));
    assert.equal(paths.plans, path.join(root, 'plans'));
    assert.equal(paths.tasks, path.join(root, 'tasks'));
    assert.equal(paths.pending, path.join(root, '.pending'));
    assert.equal(paths.questions, path.join(root, 'questions'));
    assert.equal(paths.results, path.join(root, 'results'));
    assert.equal(paths.logs, path.join(root, 'logs'));
    assert.equal(paths.archive, path.join(root, 'archive'));
    assert.equal(paths.archivedPlans, path.join(root, 'archive', 'plans'));
    assert.equal(paths.archivedTasks, path.join(root, 'archive', 'tasks'));
  });

  it('should_keep_two_folders_data_apart', () => {
    // The whole point of the layout: nothing is shared between projects.
    const a = pathsFor(path.join(folder, 'project-a'));
    const b = pathsFor(path.join(folder, 'project-b'));

    assert.notEqual(a.state, b.state);
    assert.notEqual(a.plans, b.plans);
    assert.notEqual(a.lock, b.lock);
  });
});

describe('ensureRoot', () => {
  it('should_create_every_directory_it_promises', () => {
    const paths = pathsFor(folder);

    ensureRoot(paths);

    for (const dir of [
      paths.root,
      paths.plans,
      paths.tasks,
      paths.questions,
      paths.results,
      paths.logs
    ]) {
      assert.ok(fs.statSync(dir).isDirectory(), `${dir} was not created`);
    }
  });

  it('should_not_create_the_archive_until_something_is_archived', () => {
    // The archive is made on demand, by the first archive and by the reveal
    // button. An empty `archive/` in every folder Chronos has ever opened is
    // clutter for a feature most folders never use.
    const paths = pathsFor(folder);

    ensureRoot(paths);

    assert.equal(fs.existsSync(paths.archive), false, 'ensureRoot created the archive');
  });

  it('should_report_true_only_the_first_time', () => {
    const paths = pathsFor(folder);

    const first = ensureRoot(paths);
    const second = ensureRoot(paths);

    assert.equal(first, true);
    assert.equal(second, false);
  });

  it('should_write_a_gitignore_covering_the_whole_root', () => {
    const paths = pathsFor(folder);

    ensureRoot(paths);

    assert.equal(fs.readFileSync(path.join(paths.root, '.gitignore'), 'utf8'), '*\n');
  });

  it('should_not_overwrite_a_gitignore_the_user_has_edited', () => {
    // Someone who decides to track their plans edits this file. Rewriting it on
    // every activation would silently undo that decision.
    const paths = pathsFor(folder);
    ensureRoot(paths);
    const ignore = path.join(paths.root, '.gitignore');
    fs.writeFileSync(ignore, 'state.json\nlogs/\n', 'utf8');

    ensureRoot(paths);

    assert.equal(fs.readFileSync(ignore, 'utf8'), 'state.json\nlogs/\n');
  });
});

describe('resolveLinks', () => {
  /**
   * A directory link, or false when this machine will not make one — an
   * unprivileged Windows account without developer mode is the usual reason, and
   * that is a fact about the machine rather than a failure of the rule.
   */
  function link(target: string, at: string): boolean {
    try {
      fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
      return true;
    } catch {
      return false;
    }
  }

  /** `os.tmpdir()` is itself a link on macOS, so the expected side is resolved too. */
  const real = (target: string): string => fs.realpathSync(target);

  it('should_resolve_a_link_to_where_it_actually_leads', (t) => {
    // The escape this exists to close: a link made inside the project, pointing
    // out of it, which every string comparison reads as a child of the project.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'chronos-outside-'));
    const inside = path.join(folder, 'escape');
    if (!link(outside, inside)) {
      t.skip('this machine will not create directory links');
      return;
    }

    try {
      assert.equal(resolveLinks(inside), real(outside));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('should_resolve_a_link_partway_along_a_path', (t) => {
    // The link need not be the last segment: what matters is where the whole
    // path lands, and the rest is re-appended to wherever the link led.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'chronos-outside-'));
    const inside = path.join(folder, 'alias');
    if (!link(outside, inside)) {
      t.skip('this machine will not create directory links');
      return;
    }

    try {
      assert.equal(
        resolveLinks(path.join(inside, 'packages', 'api')),
        path.join(real(outside), 'packages', 'api')
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('should_leave_a_path_that_does_not_exist_yet_alone', () => {
    // `realpathSync` throws on a missing path, and scheduling a run into a folder
    // about to be created is legitimate — so resolution walks up to the deepest
    // ancestor that is there and re-appends the rest.
    const missing = path.join(folder, 'not-made-yet', 'either');

    assert.equal(resolveLinks(missing), path.join(real(folder), 'not-made-yet', 'either'));
  });

  it('should_return_a_plain_directory_unchanged', () => {
    // So the cases above are not passing vacuously on a resolver that rewrites
    // every path it is given.
    const plain = path.join(folder, 'packages');
    fs.mkdirSync(plain);

    assert.equal(resolveLinks(plain), real(plain));
  });
});

describe('sweepPending', () => {
  const DAY_MS = 24 * 60 * 60_000;

  /** A staging folder, aged by hand — the sweep decides on the folder's mtime. */
  function session(pending: string, name: string, ageMs: number, plan?: string): string {
    const dir = path.join(pending, name);
    fs.mkdirSync(dir, { recursive: true });
    if (plan) {
      fs.writeFileSync(path.join(dir, plan), '# a plan\n', 'utf8');
    }
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, when, when);
    return dir;
  }

  it('should_remove_an_empty_staging_folder_past_the_cutoff', () => {
    const paths = pathsFor(folder);
    const stale = session(paths.pending, 'aaaaaaaaaaaa', 3 * DAY_MS);

    const report = sweepPending(paths.pending);

    assert.equal(report.removed, 1);
    assert.deepEqual(report.kept, []);
    assert.equal(fs.existsSync(stale), false);
  });

  it('should_keep_a_folder_younger_than_the_cutoff', () => {
    // The second-window case: another window may have a session in flight right
    // now, and deleting its staging folder breaks the write it is waiting for.
    const paths = pathsFor(folder);
    const live = session(paths.pending, 'bbbbbbbbbbbb', 5 * 60_000);

    const report = sweepPending(paths.pending);

    assert.equal(report.removed, 0);
    assert.equal(fs.existsSync(live), true);
  });

  it('should_keep_a_stale_folder_that_still_holds_a_plan_and_report_it', () => {
    // The plan in there is generated work that never reached the library, and
    // this is the only copy of it.
    const paths = pathsFor(folder);
    const rescuable = session(paths.pending, 'cccccccccccc', 3 * DAY_MS, 'add-a-retry-button.md');

    const report = sweepPending(paths.pending);

    assert.equal(report.removed, 0);
    assert.deepEqual(report.kept, [rescuable]);
    assert.equal(fs.existsSync(rescuable), true);
  });

  it('should_report_nothing_for_a_pending_folder_that_was_never_created', () => {
    // A folder that has never generated a plan has no `.pending` at all.
    const paths = pathsFor(folder);

    const report = sweepPending(paths.pending);

    assert.deepEqual(report, { removed: 0, kept: [] });
  });
});

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { consolidate, SeriesStore } from '../src/consolidate';
import { createPlan, isInside, listPlans, readPlan } from '../src/library';
import { TaskSeries } from '../src/types';

/**
 * `consolidate` takes a structural `SeriesStore` rather than the real class, so
 * these run against a plain object and a temp directory — no `vscode`, no
 * `globalState`, and every write is observable.
 */
class FakeStore implements SeriesStore {
  /** Every id ever passed to `removeSeries`, so the prune step is checkable. */
  readonly removed: string[] = [];

  constructor(private series: TaskSeries[] = []) {}

  getSeries(): readonly TaskSeries[] {
    return this.series;
  }

  async updateSeries(id: string, patch: Partial<TaskSeries>): Promise<void> {
    this.series = this.series.map((s) => (s.id === id ? { ...s, ...patch } : s));
  }

  async removeSeries(id: string): Promise<void> {
    this.removed.push(id);
    this.series = this.series.filter((s) => s.id !== id);
  }

  byId(id: string): TaskSeries | undefined {
    return this.series.find((s) => s.id === id);
  }
}

let dir: string;
let outside: string;
let archive: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synchrony-lib-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'synchrony-out-'));
  archive = fs.mkdtempSync(path.join(os.tmpdir(), 'synchrony-arch-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  fs.rmSync(archive, { recursive: true, force: true });
});

/** Writes a plan file outside the library and returns its path. */
function sourceFile(name: string, text = '# Outside\n'): string {
  const filePath = path.join(outside, name);
  fs.writeFileSync(filePath, text);
  return filePath;
}

function series(id: string, filePath: string, overrides: Partial<TaskSeries> = {}): TaskSeries {
  return {
    id,
    filePath,
    fileName: path.basename(filePath),
    cwd: path.join(outside, 'project'),
    permissionMode: 'auto',
    recurrence: null,
    nextRunAt: '2026-01-01T09:00:00.000Z',
    enabled: true,
    maxRetries: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

describe('consolidate — importing outside plans', () => {
  it('should_copy_an_outside_plan_in_and_repoint_its_series', async () => {
    const sourcePath = sourceFile('nightly.md', '# Nightly\n');
    const store = new FakeStore([series('a', sourcePath)]);

    const report = await consolidate(store, dir, archive);

    const moved = store.byId('a');
    assert.ok(moved);
    assert.ok(isInside(dir, moved.filePath), 'the series must point into the library');
    assert.equal(moved.fileName, 'nightly.md');
    assert.equal(readPlan(dir, 'nightly.md'), '# Nightly\n');
    assert.deepEqual(report.imported, [{ sourcePath, planName: 'nightly.md' }]);
  });

  it('should_leave_the_original_file_untouched', async () => {
    // Copy, never move. The user's file is theirs; Synchrony runs the copy.
    const sourcePath = sourceFile('keep-me.md', 'original');
    const store = new FakeStore([series('a', sourcePath)]);

    await consolidate(store, dir, archive);

    assert.equal(fs.existsSync(sourcePath), true);
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'original');
  });

  it('should_leave_the_working_directory_alone', async () => {
    // The plan moves into global storage; the work it does still belongs to
    // whichever project it was running against.
    const cwd = path.join(outside, 'some-project');
    const store = new FakeStore([series('a', sourceFile('nightly.md'), { cwd })]);

    await consolidate(store, dir, archive);

    assert.equal(store.byId('a')?.cwd, cwd);
  });

  it('should_preserve_the_schedule_of_a_series_it_moves', async () => {
    const store = new FakeStore([
      series('a', sourceFile('nightly.md'), {
        recurrence: { daysOfWeek: [1, 3, 5], timeLocal: '07:30' },
        nextRunAt: '2026-03-04T07:30:00.000Z',
        enabled: false,
        maxRetries: 5
      })
    ]);

    await consolidate(store, dir, archive);

    const moved = store.byId('a');
    assert.deepEqual(moved?.recurrence, { daysOfWeek: [1, 3, 5], timeLocal: '07:30' });
    assert.equal(moved?.nextRunAt, '2026-03-04T07:30:00.000Z');
    assert.equal(moved?.enabled, false);
    assert.equal(moved?.maxRetries, 5);
  });

  it('should_share_one_copy_between_series_pointing_at_the_same_file', async () => {
    // Two copies would leave the user with two plans where they had one, and an
    // edit to either would silently stop reaching the other run.
    const sourcePath = sourceFile('shared.md');
    const store = new FakeStore([series('a', sourcePath), series('b', sourcePath)]);

    const report = await consolidate(store, dir, archive);

    assert.equal(listPlans(dir).length, 1);
    assert.equal(report.imported.length, 1);
    assert.equal(store.byId('a')?.filePath, store.byId('b')?.filePath);
  });

  it('should_deduplicate_against_a_library_plan_of_the_same_name', async () => {
    const existing = createPlan(dir, 'Nightly', 'the library one');
    const store = new FakeStore([series('a', sourceFile('nightly.md', 'the outside one'))]);

    await consolidate(store, dir, archive);

    assert.equal(store.byId('a')?.fileName, 'nightly-2.md');
    assert.equal(readPlan(dir, 'nightly-2.md'), 'the outside one');
    assert.equal(readPlan(dir, existing.name), 'the library one', 'the existing plan was clobbered');
  });

  it('should_leave_a_series_already_in_the_library_alone', async () => {
    const plan = createPlan(dir, 'Already Here');
    const store = new FakeStore([series('a', plan.filePath)]);

    const report = await consolidate(store, dir, archive);

    assert.deepEqual(report.imported, []);
    assert.equal(store.byId('a')?.filePath, plan.filePath);
    assert.equal(listPlans(dir).length, 1);
  });

  it('should_change_nothing_on_a_second_run', async () => {
    // Idempotent by nature rather than by a version gate: after one pass every
    // path is already inside the library, so there is nothing left to find.
    const store = new FakeStore([series('a', sourceFile('nightly.md'))]);
    await consolidate(store, dir, archive);
    const after = store.byId('a');

    const report = await consolidate(store, dir, archive);

    assert.deepEqual(report.imported, []);
    assert.deepEqual(report.droppedSchedules, []);
    assert.deepEqual(store.byId('a'), after);
    assert.equal(listPlans(dir).length, 1);
  });
});

describe('consolidate — archived plans', () => {
  it('should_not_re_import_a_plan_that_has_been_archived', async () => {
    // A plan that has run is outside the library on purpose. Copying it back
    // would put it straight into the list it just left, on the next tick.
    const archived = createPlan(archive, 'Nightly', '# Nightly\n');
    const store = new FakeStore([series('a', archived.filePath, { spent: true })]);

    const report = await consolidate(store, dir, archive);

    assert.deepEqual(report.imported, []);
    assert.deepEqual(listPlans(dir), []);
    assert.equal(store.byId('a')?.filePath, archived.filePath);
  });

  it('should_not_drop_the_schedule_of_an_archived_plan', async () => {
    // The run history hangs off the series, and the Runs panel reads the plan's
    // name from it. Pruning the series would take both.
    const archived = createPlan(archive, 'Nightly');
    const store = new FakeStore([series('a', archived.filePath, { spent: true })]);

    const report = await consolidate(store, dir, archive);

    assert.deepEqual(store.removed, []);
    assert.deepEqual(report.droppedSchedules, []);
    assert.equal(store.getSeries().length, 1);
  });
});

describe('consolidate — pruning schedules with no file', () => {
  it('should_remove_a_series_whose_library_plan_is_gone', async () => {
    // Left alone it would fire and fail on schedule, forever.
    const plan = createPlan(dir, 'Deleted');
    const store = new FakeStore([series('a', plan.filePath)]);
    fs.unlinkSync(plan.filePath);

    const report = await consolidate(store, dir, archive);

    assert.deepEqual(store.removed, ['a']);
    assert.deepEqual(report.droppedSchedules, ['deleted.md']);
    assert.equal(store.getSeries().length, 0);
  });

  it('should_remove_a_series_whose_outside_file_is_gone', async () => {
    // Nothing to import and nothing to run: the source vanished before upgrade.
    const store = new FakeStore([series('a', path.join(outside, 'never-existed.md'))]);

    const report = await consolidate(store, dir, archive);

    assert.deepEqual(store.removed, ['a']);
    assert.deepEqual(report.imported, []);
    assert.deepEqual(report.droppedSchedules, ['never-existed.md']);
  });

  it('should_keep_every_other_series_when_one_is_pruned', async () => {
    const kept = createPlan(dir, 'Kept');
    const doomed = createPlan(dir, 'Doomed');
    const store = new FakeStore([series('a', kept.filePath), series('b', doomed.filePath)]);
    fs.unlinkSync(doomed.filePath);

    await consolidate(store, dir, archive);

    assert.deepEqual(store.removed, ['b']);
    assert.deepEqual(store.getSeries().map((s) => s.id), ['a']);
  });
});

describe('consolidate — unreadable library', () => {
  it('should_remove_nothing_when_the_library_folder_cannot_be_read', async () => {
    // A `synchrony.libraryPath` on an unplugged drive reads as "no files here".
    // Pruning on that would delete a whole schedule for a kicked-out cable.
    const gone = path.join(dir, 'not-mounted');
    const store = new FakeStore([series('a', path.join(gone, 'nightly.md'))]);

    const report = await consolidate(store, gone, archive);

    assert.ok(report.libraryUnreadable, 'the report must say why nothing happened');
    assert.deepEqual(store.removed, []);
    assert.equal(store.getSeries().length, 1);
  });

  it('should_not_import_when_the_library_folder_cannot_be_read', async () => {
    const sourcePath = sourceFile('nightly.md');
    const store = new FakeStore([series('a', sourcePath)]);

    const report = await consolidate(store, path.join(dir, 'not-mounted'), archive);

    assert.deepEqual(report.imported, []);
    assert.equal(store.byId('a')?.filePath, sourcePath, 'the series must keep its old path');
  });
});

describe('consolidate — nothing to do', () => {
  it('should_succeed_on_an_empty_schedule', async () => {
    const store = new FakeStore([]);

    const report = await consolidate(store, dir, archive);

    assert.deepEqual(report, { imported: [], droppedSchedules: [] });
  });
});

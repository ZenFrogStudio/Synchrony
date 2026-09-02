import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createPlan, isInside, listPlans } from '../src/library';
import { retireCompletedPlans, RetireStore } from '../src/retire';
import { RunStatus, TaskRun, TaskSeries } from '../src/types';

/**
 * `retireCompletedPlans` takes a structural `RetireStore` rather than the real
 * class, so these run against a plain object and two temp directories — no
 * `vscode`, no `globalState`, and every write is observable.
 */
class FakeStore implements RetireStore {
  constructor(
    private series: TaskSeries[] = [],
    private runs: TaskRun[] = []
  ) {}

  getSeries(): readonly TaskSeries[] {
    return this.series;
  }

  getRuns(): readonly TaskRun[] {
    return this.runs;
  }

  async updateSeries(id: string, patch: Partial<TaskSeries>): Promise<void> {
    this.series = this.series.map((s) => (s.id === id ? { ...s, ...patch } : s));
  }

  byId(id: string): TaskSeries | undefined {
    return this.series.find((s) => s.id === id);
  }
}

let dir: string;
let archive: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronos-lib-'));
  archive = fs.mkdtempSync(path.join(os.tmpdir(), 'chronos-arch-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(archive, { recursive: true, force: true });
});

function series(id: string, filePath: string, overrides: Partial<TaskSeries> = {}): TaskSeries {
  return {
    id,
    filePath,
    fileName: path.basename(filePath),
    cwd: path.join(dir, 'project'),
    permissionMode: 'auto',
    recurrence: null,
    nextRunAt: '2026-01-01T09:00:00.000Z',
    enabled: true,
    maxRetries: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function run(
  id: string,
  seriesId: string,
  status: RunStatus,
  overrides: Partial<TaskRun> = {}
): TaskRun {
  return {
    id,
    seriesId,
    scheduledAt: '2026-01-01T09:00:00.000Z',
    status,
    attempt: 1,
    ...overrides
  };
}

describe('retire — a one-shot that has run', () => {
  it('should_archive_a_one_shot_whose_run_completed', async () => {
    const plan = createPlan(dir, 'Nightly');
    const store = new FakeStore([series('a', plan.filePath)], [run('r1', 'a', 'completed')]);

    const report = await retireCompletedPlans(store, dir, archive);

    assert.equal(fs.existsSync(plan.filePath), false, 'the plan must leave the library');
    assert.deepEqual(listPlans(dir), []);
    assert.deepEqual(
      listPlans(archive).map((p) => p.name),
      ['nightly.md']
    );

    const moved = store.byId('a');
    assert.ok(moved);
    assert.ok(isInside(archive, moved.filePath), 'the series must point into the archive');
    assert.equal(moved.fileName, 'nightly.md');
    assert.deepEqual(report.archived, [{ planName: 'nightly.md', archivedAs: 'nightly.md' }]);
  });

  it('should_mark_the_series_spent_so_it_cannot_fire_from_the_archive', async () => {
    // A manual "Run now" completes before the scheduled occurrence arrives. Left
    // live, that occurrence would fire later out of the archive folder with no
    // row anywhere to show for it.
    const plan = createPlan(dir, 'Nightly');
    const store = new FakeStore(
      [series('a', plan.filePath, { spent: false })],
      [{ ...run('r1', 'a', 'completed'), manual: true }]
    );

    await retireCompletedPlans(store, dir, archive);

    assert.equal(store.byId('a')?.spent, true);
  });

  it('should_leave_a_recurring_plan_in_the_library', async () => {
    // A repeat rule always has a next time, so the file is still needed.
    const plan = createPlan(dir, 'Every Weekday');
    const store = new FakeStore(
      [series('a', plan.filePath, { recurrence: { daysOfWeek: [1, 2, 3, 4, 5], timeLocal: '09:00' } })],
      [run('r1', 'a', 'completed')]
    );

    const report = await retireCompletedPlans(store, dir, archive);

    assert.deepEqual(report.archived, []);
    assert.equal(fs.existsSync(plan.filePath), true);
    assert.equal(store.byId('a')?.filePath, plan.filePath);
  });
});

describe('retire — a plan that has stopped repeating', () => {
  it('should_leave_a_plan_that_only_ran_before_its_repeat_rule_was_removed', async () => {
    // Switch Repeat from Weekly to Once and the series is a one-shot with a pile
    // of completed runs behind it. Those runs were made under a rule it no
    // longer has, so archiving on them would take the plan out of the library
    // before the one-shot occurrence the user just set had fired.
    const plan = createPlan(dir, 'Was Weekly');
    const store = new FakeStore(
      [series('a', plan.filePath, { repeatEndedAt: '2026-02-01T00:00:00.000Z' })],
      [run('r1', 'a', 'completed', { startedAt: '2026-01-20T09:00:00.000Z' })]
    );

    const report = await retireCompletedPlans(store, dir, archive);

    assert.deepEqual(report.archived, []);
    assert.equal(fs.existsSync(plan.filePath), true);
    assert.equal(store.byId('a')?.spent, undefined);
  });

  it('should_archive_a_plan_that_has_run_since_its_repeat_rule_was_removed', async () => {
    const plan = createPlan(dir, 'Was Weekly');
    const store = new FakeStore(
      [series('a', plan.filePath, { repeatEndedAt: '2026-02-01T00:00:00.000Z' })],
      [
        run('r1', 'a', 'completed', { startedAt: '2026-01-20T09:00:00.000Z' }),
        run('r2', 'a', 'completed', { startedAt: '2026-02-02T09:00:00.000Z' })
      ]
    );

    const report = await retireCompletedPlans(store, dir, archive);

    assert.deepEqual(report.archived, [{ planName: 'was-weekly.md', archivedAs: 'was-weekly.md' }]);
    assert.equal(fs.existsSync(plan.filePath), false);
    assert.ok(isInside(archive, store.byId('a')?.filePath ?? ''));
  });

  it('should_leave_a_plan_whose_run_has_no_start_time_to_place', async () => {
    // A run with no start time cannot be put either side of the change. Kept, on
    // the reasoning that a plan wrongly left in the library is a row in a list,
    // while one wrongly archived has to be gone looking for.
    const plan = createPlan(dir, 'Undated');
    const store = new FakeStore(
      [series('a', plan.filePath, { repeatEndedAt: '2026-02-01T00:00:00.000Z' })],
      [run('r1', 'a', 'completed')]
    );

    const report = await retireCompletedPlans(store, dir, archive);

    assert.deepEqual(report.archived, []);
    assert.equal(fs.existsSync(plan.filePath), true);
  });
});

describe('retire — plans that must stay put', () => {
  it('should_leave_a_one_shot_whose_run_failed', async () => {
    // It stays in the library to be fixed and re-run in place, which means it
    // has to stay visible too.
    const plan = createPlan(dir, 'Broken');
    const store = new FakeStore([series('a', plan.filePath)], [run('r1', 'a', 'failed')]);

    const report = await retireCompletedPlans(store, dir, archive);

    assert.deepEqual(report.archived, []);
    assert.equal(fs.existsSync(plan.filePath), true);
    assert.equal(store.byId('a')?.spent, undefined);
  });

  it('should_leave_a_one_shot_whose_run_was_cancelled', async () => {
    const plan = createPlan(dir, 'Stopped');
    const store = new FakeStore([series('a', plan.filePath)], [run('r1', 'a', 'cancelled')]);

    const report = await retireCompletedPlans(store, dir, archive);

    assert.deepEqual(report.archived, []);
    assert.equal(fs.existsSync(plan.filePath), true);
  });

  it('should_leave_a_one_shot_whose_run_was_missed', async () => {
    // A missed occurrence is still waiting on a decision — it has not run.
    const plan = createPlan(dir, 'Overslept');
    const store = new FakeStore([series('a', plan.filePath)], [run('r1', 'a', 'missed')]);

    const report = await retireCompletedPlans(store, dir, archive);

    assert.deepEqual(report.archived, []);
    assert.equal(fs.existsSync(plan.filePath), true);
  });

  it('should_not_archive_while_a_retry_is_pending', async () => {
    // The retry queued after a failure still needs the file an hour from now.
    const plan = createPlan(dir, 'Flaky');
    const store = new FakeStore(
      [series('a', plan.filePath)],
      [run('r1', 'a', 'completed'), run('r2', 'a', 'pending')]
    );

    const report = await retireCompletedPlans(store, dir, archive);

    assert.deepEqual(report.archived, []);
    assert.equal(fs.existsSync(plan.filePath), true);
  });

  it('should_not_archive_while_a_run_is_still_going', async () => {
    const plan = createPlan(dir, 'In Flight');
    const store = new FakeStore(
      [series('a', plan.filePath)],
      [run('r1', 'a', 'completed'), run('r2', 'a', 'running')]
    );

    const report = await retireCompletedPlans(store, dir, archive);

    assert.deepEqual(report.archived, []);
    assert.equal(fs.existsSync(plan.filePath), true);
  });
});

describe('retire — a chain still working through itself', () => {
  const link = (after: string) => ({ after, delayMinutes: 15, stopOnFailure: true });

  it('should_keep_a_finished_plan_while_the_chain_behind_it_is_still_going', async () => {
    // Otherwise the plans leave the library one at a time as the chain works
    // through them, and the ones still to run name a plan no longer in the list.
    const first = createPlan(dir, 'Audit');
    const second = createPlan(dir, 'Review');
    const store = new FakeStore(
      [
        series('a', first.filePath, { spent: true }),
        series('b', second.filePath, { spent: true, chain: link('a') })
      ],
      [run('r1', 'a', 'completed')]
    );

    const report = await retireCompletedPlans(store, dir, archive);

    assert.deepEqual(report.archived, []);
    assert.equal(fs.existsSync(first.filePath), true);
  });

  it('should_archive_the_whole_chain_once_every_plan_in_it_is_done', async () => {
    const first = createPlan(dir, 'Audit');
    const second = createPlan(dir, 'Review');
    const store = new FakeStore(
      [
        series('a', first.filePath, { spent: true }),
        series('b', second.filePath, { spent: true, chain: link('a') })
      ],
      [run('r1', 'a', 'completed'), run('r2', 'b', 'completed')]
    );

    const report = await retireCompletedPlans(store, dir, archive);

    assert.deepEqual(
      report.archived.map((a) => a.planName).sort(),
      ['audit.md', 'review.md']
    );
  });

  it('should_take_the_link_off_a_follower_it_retires', async () => {
    // `spent` is how a follower waits its turn, so a retired one still reads as
    // parked. Left linked as well, the arming rule would re-arm it out of the
    // archive the next time the plan before it produced a finished run — which
    // pressing Re-run on the head is enough to do.
    const first = createPlan(dir, 'Audit');
    const second = createPlan(dir, 'Review');
    const store = new FakeStore(
      [
        series('a', first.filePath, { spent: true }),
        series('b', second.filePath, { spent: true, chain: link('a') })
      ],
      [run('r1', 'a', 'completed'), run('r2', 'b', 'completed')]
    );

    await retireCompletedPlans(store, dir, archive);

    assert.equal(store.byId('b')?.chain, undefined, 'the follower must come back unlinked');
    assert.equal(store.byId('b')?.spent, true);
    assert.equal(store.byId('a')?.chain, undefined, 'the head never had a link to lose');
  });

  it('should_release_a_finished_plan_once_the_chain_has_stopped', async () => {
    // A link switched off by a failure is not going to run. Waiting on it would
    // hold the plans that did run in the library for good.
    const first = createPlan(dir, 'Audit');
    const second = createPlan(dir, 'Review');
    const store = new FakeStore(
      [
        series('a', first.filePath, { spent: true }),
        series('b', second.filePath, { spent: true, enabled: false, chain: link('a') })
      ],
      [run('r1', 'a', 'completed')]
    );

    const report = await retireCompletedPlans(store, dir, archive);

    assert.deepEqual(report.archived, [{ planName: 'audit.md', archivedAs: 'audit.md' }]);
    assert.equal(fs.existsSync(second.filePath), true, 'the plan that never ran stays');
  });
});

describe('retire — a plan two series share', () => {
  it('should_leave_a_plan_two_series_share_when_only_one_is_done', async () => {
    // Moving it would leave the unfinished schedule pointing at nothing, and
    // `consolidate` would then drop that schedule and its history.
    const plan = createPlan(dir, 'Shared');
    const store = new FakeStore(
      [series('a', plan.filePath), series('b', plan.filePath)],
      [run('r1', 'a', 'completed')]
    );

    const report = await retireCompletedPlans(store, dir, archive);

    assert.deepEqual(report.archived, []);
    assert.equal(fs.existsSync(plan.filePath), true);
    assert.equal(store.byId('a')?.filePath, plan.filePath);
  });

  it('should_repoint_every_series_sharing_a_plan_that_is_done', async () => {
    const plan = createPlan(dir, 'Shared');
    const store = new FakeStore(
      [series('a', plan.filePath), series('b', plan.filePath)],
      [run('r1', 'a', 'completed'), run('r2', 'b', 'completed')]
    );

    const report = await retireCompletedPlans(store, dir, archive);

    assert.equal(report.archived.length, 1, 'one file, one move');
    assert.equal(listPlans(archive).length, 1);
    assert.equal(store.byId('a')?.filePath, store.byId('b')?.filePath);
    assert.ok(isInside(archive, store.byId('b')?.filePath ?? ''));
    assert.equal(store.byId('b')?.spent, true);
  });
});

describe('retire — tolerance and repetition', () => {
  it('should_do_nothing_on_a_second_pass', async () => {
    // The series now points into the archive, which fails the "still in the
    // library" test — so this is idempotent by nature, not by a version gate.
    const plan = createPlan(dir, 'Nightly');
    const store = new FakeStore([series('a', plan.filePath)], [run('r1', 'a', 'completed')]);
    await retireCompletedPlans(store, dir, archive);
    const after = store.byId('a');

    const report = await retireCompletedPlans(store, dir, archive);

    assert.deepEqual(report.archived, []);
    assert.equal(listPlans(archive).length, 1, 'no second copy in the archive');
    assert.deepEqual(store.byId('a'), after);
  });

  it('should_keep_going_when_one_plan_cannot_be_moved', async () => {
    // One plan that cannot be moved must not strand every other finished plan.
    const gone = path.join(dir, 'vanished.md');
    const movable = createPlan(dir, 'Movable');
    const store = new FakeStore(
      [series('a', gone), series('b', movable.filePath)],
      [run('r1', 'a', 'completed'), run('r2', 'b', 'completed')]
    );

    const report = await retireCompletedPlans(store, dir, archive);

    assert.deepEqual(report.archived, [{ planName: 'movable.md', archivedAs: 'movable.md' }]);
    assert.equal(store.byId('a')?.filePath, gone, 'the unmovable plan keeps its path');
    assert.ok(isInside(archive, store.byId('b')?.filePath ?? ''));
  });

  it('should_succeed_on_an_empty_schedule', async () => {
    const store = new FakeStore([]);

    const report = await retireCompletedPlans(store, dir, archive);

    assert.deepEqual(report, { archived: [] });
  });
});

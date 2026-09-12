import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { adoptGlobal, claimAdoption, LegacyPaths } from '../src/adopt';
import { ensureRoot, pathsFor } from '../src/roots';
import { SynchronyPaths } from '../src/roots';
import { SynchronyState, SCHEMA_VERSION, TaskSeries } from '../src/types';

let tmp: string;
/** The old machine-wide storage root — what every window shares. */
let storage: string;
let legacy: LegacyPaths;
let next: SynchronyPaths;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synchrony-adopt-'));

  storage = path.join(tmp, 'globalStorage');
  const old = path.join(storage, 'plans');
  legacy = {
    plans: old,
    tasks: path.join(old, 'tasks'),
    results: path.join(old, 'results')
  };
  for (const dir of Object.values(legacy)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  next = pathsFor(path.join(tmp, 'project'));
  ensureRoot(next);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function legacyPlan(name: string, body = '# plan\n'): string {
  const filePath = path.join(legacy.plans, name);
  fs.writeFileSync(filePath, body, 'utf8');
  return filePath;
}

function series(filePath: string, overrides: Partial<TaskSeries> = {}): TaskSeries {
  return {
    id: 'series-1',
    filePath,
    fileName: path.basename(filePath),
    cwd: '/work/somewhere-else',
    permissionMode: 'auto',
    recurrence: null,
    nextRunAt: '2026-08-09T02:00:00.000Z',
    enabled: true,
    maxRetries: 3,
    createdAt: '2026-08-08T12:00:00.000Z',
    ...overrides
  };
}

const state = (series: TaskSeries[]): SynchronyState => ({
  schemaVersion: SCHEMA_VERSION,
  series,
  runs: []
});

describe('adoptGlobal', () => {
  it('should_copy_plans_tasks_and_results_into_the_new_root', () => {
    legacyPlan('nightly-audit.md', '# Nightly audit\n');
    fs.writeFileSync(path.join(legacy.tasks, 'fix-the-thing.md'), 'Fix the thing\n', 'utf8');
    fs.mkdirSync(path.join(legacy.results, 'nightly-audit'), { recursive: true });
    fs.writeFileSync(
      path.join(legacy.results, 'nightly-audit', '2026-07-26-2130-completed.md'),
      'ran\n',
      'utf8'
    );

    const { report } = adoptGlobal(legacy, next, undefined);

    assert.equal(report.plans, 1);
    assert.equal(report.tasks, 1);
    assert.equal(report.results, true);
    assert.equal(
      fs.readFileSync(path.join(next.plans, 'nightly-audit.md'), 'utf8'),
      '# Nightly audit\n'
    );
    assert.equal(
      fs.readFileSync(path.join(next.tasks, 'fix-the-thing.md'), 'utf8'),
      'Fix the thing\n'
    );
    assert.ok(
      fs.existsSync(path.join(next.results, 'nightly-audit', '2026-07-26-2130-completed.md'))
    );
  });

  it('should_leave_the_originals_where_they_were', () => {
    // An upgrade that deletes the only copy of a year of history is not
    // recoverable. Everything here is a copy.
    const original = legacyPlan('nightly-audit.md');

    adoptGlobal(legacy, next, undefined);

    assert.ok(fs.existsSync(original));
  });

  it('should_repoint_a_series_at_the_copied_plan', () => {
    const original = legacyPlan('nightly-audit.md');

    const { state: adopted, report } = adoptGlobal(legacy, next, state([series(original)]));

    assert.equal(report.repointed, 1);
    assert.equal(adopted.series[0].filePath, path.join(next.plans, 'nightly-audit.md'));
    assert.equal(adopted.series[0].fileName, 'nightly-audit.md');
  });

  it('should_leave_the_cwd_of_an_adopted_series_alone', () => {
    // The plan moved; the work it does still belongs to whichever project it
    // ran against.
    const original = legacyPlan('nightly-audit.md');

    const { state: adopted } = adoptGlobal(
      legacy,
      next,
      state([series(original, { cwd: '/work/somewhere-else' })])
    );

    assert.equal(adopted.series[0].cwd, '/work/somewhere-else');
  });

  it('should_share_one_copy_between_two_series_on_the_same_plan', () => {
    const original = legacyPlan('nightly-audit.md');

    const { state: adopted } = adoptGlobal(
      legacy,
      next,
      state([series(original, { id: 'a' }), series(original, { id: 'b' })])
    );

    assert.equal(adopted.series[0].filePath, adopted.series[1].filePath);
    assert.deepEqual(fs.readdirSync(next.plans), ['nightly-audit.md']);
  });

  it('should_not_overwrite_a_plan_the_target_folder_already_has', () => {
    fs.writeFileSync(path.join(next.plans, 'nightly-audit.md'), 'already mine\n', 'utf8');
    const original = legacyPlan('nightly-audit.md', 'the old one\n');

    const { state: adopted } = adoptGlobal(legacy, next, state([series(original)]));

    assert.equal(
      fs.readFileSync(path.join(next.plans, 'nightly-audit.md'), 'utf8'),
      'already mine\n'
    );
    assert.equal(adopted.series[0].fileName, 'nightly-audit-2.md');
    assert.equal(
      fs.readFileSync(path.join(next.plans, 'nightly-audit-2.md'), 'utf8'),
      'the old one\n'
    );
  });

  it('should_leave_a_series_whose_plan_was_never_in_the_library_untouched', () => {
    // `consolidate()` runs straight after and decides that case properly.
    const outside = path.join(tmp, 'elsewhere.md');
    fs.writeFileSync(outside, '# elsewhere\n', 'utf8');

    const { state: adopted, report } = adoptGlobal(legacy, next, state([series(outside)]));

    assert.equal(report.repointed, 0);
    assert.equal(adopted.series[0].filePath, outside);
  });

  it('should_produce_an_empty_schedule_when_there_was_none_before', () => {
    const { state: adopted } = adoptGlobal(legacy, next, undefined);

    assert.deepEqual(adopted, { schemaVersion: SCHEMA_VERSION, series: [], runs: [] });
  });

  it('should_copy_nothing_when_the_old_library_is_already_the_new_one', () => {
    // What `synchrony.libraryPath` pointing into the adopting folder produces.
    // Copying a directory into itself would duplicate every plan under a `-2`
    // name, once per activation.
    const shared: LegacyPaths = { plans: next.plans, tasks: next.tasks, results: next.results };
    fs.writeFileSync(path.join(next.plans, 'nightly-audit.md'), '# Nightly audit\n', 'utf8');
    fs.writeFileSync(path.join(next.tasks, 'fix-the-thing.md'), 'Fix the thing\n', 'utf8');

    const { report } = adoptGlobal(shared, next, undefined);

    assert.equal(report.plans, 0);
    assert.equal(report.tasks, 0);
    assert.equal(report.results, false);
    assert.deepEqual(fs.readdirSync(next.plans), ['nightly-audit.md']);
    assert.deepEqual(fs.readdirSync(next.tasks), ['fix-the-thing.md']);
  });

  it('should_cope_with_a_results_folder_that_was_never_created', () => {
    fs.rmSync(legacy.results, { recursive: true, force: true });

    const { report } = adoptGlobal(legacy, next, undefined);

    assert.equal(report.results, false);
  });
});

describe('claimAdoption', () => {
  /**
   * What `adoptOnce` in extension.ts does, minus the `globalState` flag — that
   * flag is the gate this one exists to back up, and it needs `vscode`.
   */
  function windowActivates(): boolean {
    if (!claimAdoption(storage)) {
      return false;
    }
    adoptGlobal(legacy, next, undefined);
    return true;
  }

  it('should_let_the_first_window_to_ask_adopt', () => {
    legacyPlan('nightly-audit.md');

    assert.equal(windowActivates(), true);
    assert.deepEqual(fs.readdirSync(next.plans), ['nightly-audit.md']);
  });

  it('should_copy_nothing_for_a_second_window_that_asks_after_the_first', () => {
    // Two windows open when the new build first loads. Without the claim both
    // read "not adopted yet" and every plan lands in two projects at once, each
    // with its schedule, each window then firing it.
    legacyPlan('nightly-audit.md');
    windowActivates();

    assert.equal(windowActivates(), false);
    assert.deepEqual(fs.readdirSync(next.plans), ['nightly-audit.md']);
  });

  it('should_claim_in_the_shared_storage_rather_than_the_folder_being_adopted_into', () => {
    // The old storage is the contended thing — a marker inside one project's
    // .synchrony would say nothing to a window opened on another project.
    claimAdoption(storage);

    assert.ok(fs.existsSync(path.join(storage, 'adopted.marker')));
    assert.ok(!fs.existsSync(path.join(next.root, 'adopted.marker')));
  });

  it('should_create_a_global_storage_directory_vs_code_has_not_made_yet', () => {
    // A missing directory would fail the open, read as "somebody else claimed
    // it", and strand the legacy data forever.
    const unmade = path.join(tmp, 'never-created');

    assert.equal(claimAdoption(unmade), true);
  });
});

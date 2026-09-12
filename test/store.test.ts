import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readState, updateState, writeState } from '../src/state-file';
import { SynchronyState, SCHEMA_VERSION, TaskRun, TaskSeries } from '../src/types';

/**
 * How the store persists a change: read the file, apply the change to that,
 * write it back.
 *
 * `Store` itself imports `vscode` for its change event, so what is exercised
 * here is `updateState` — the whole of what `Store.persist` does, and the part
 * the multi-window behaviour depends on. Same arrangement as
 * `state-file.test.ts`, and the reason both can run under plain Node.
 */

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synchrony-store-'));
  file = path.join(dir, 'state.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function series(overrides: Partial<TaskSeries> = {}): TaskSeries {
  return {
    id: 'series-1',
    filePath: '/plans/nightly.md',
    fileName: 'nightly.md',
    cwd: '/work/project',
    permissionMode: 'auto',
    recurrence: null,
    nextRunAt: '2026-08-09T02:00:00.000Z',
    enabled: true,
    maxRetries: 3,
    createdAt: '2026-08-08T12:00:00.000Z',
    ...overrides
  };
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run-1',
    seriesId: 'series-1',
    scheduledAt: '2026-08-09T02:00:00.000Z',
    status: 'completed',
    attempt: 1,
    ...overrides
  };
}

const state = (overrides: Partial<SynchronyState> = {}): SynchronyState => ({
  schemaVersion: SCHEMA_VERSION,
  series: [series()],
  runs: [],
  ...overrides
});

describe('updateState', () => {
  it('should_keep_what_another_window_wrote_after_this_one_loaded', () => {
    // Two windows on one folder. The bystander loads, the window holding the
    // lock records a run, and the bystander then edits something unrelated.
    writeState(file, state());
    const snapshot = readState(file).state;

    writeState(file, { ...snapshot, runs: [run()] });

    const after = updateState(file, (fresh) => {
      fresh.series[0].fileName = 'renamed.md';
    });

    // Writing the snapshot back would have taken the run with it.
    assert.equal(after.runs.length, 1);
    assert.equal(after.series[0].fileName, 'renamed.md');
  });

  it('should_leave_the_file_holding_exactly_what_it_returned', () => {
    writeState(file, state());

    const after = updateState(file, (fresh) => {
      fresh.runs.push(run());
    });

    assert.deepEqual(readState(file).state, after);
  });

  it('should_start_from_an_empty_schedule_when_the_folder_has_no_state_file', () => {
    // Every folder looks like this before Synchrony has run in it, and the first
    // write must not be treated as a failed read.
    const after = updateState(file, (fresh) => {
      fresh.series.push(series());
    });

    assert.equal(after.series.length, 1);
    assert.equal(readState(file).state.series[0].id, 'series-1');
  });

  it('should_apply_a_removal_to_the_file_rather_than_to_a_stale_copy', () => {
    // The other half of the same problem: a delete made against a snapshot
    // would also resurrect anything added since.
    writeState(file, state({ series: [series({ id: 'a' })] }));
    const snapshot = readState(file).state;

    writeState(file, { ...snapshot, series: [...snapshot.series, series({ id: 'b' })] });

    const after = updateState(file, (fresh) => {
      fresh.series = fresh.series.filter((s) => s.id !== 'a');
    });

    assert.deepEqual(
      after.series.map((s) => s.id),
      ['b']
    );
  });
});

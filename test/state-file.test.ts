import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { emptyState, readState, writeState } from '../src/state-file';
import { SynchronyState, SCHEMA_VERSION, TaskRun, TaskSeries } from '../src/types';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synchrony-state-'));
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

describe('readState', () => {
  it('should_return_an_empty_schedule_for_a_folder_synchrony_has_never_run_in', () => {
    const result = readState(file);

    assert.deepEqual(result.state, emptyState());
    assert.equal(result.backedUpTo, undefined);
  });

  it('should_round_trip_a_schedule_through_disk', () => {
    const written: SynchronyState = {
      schemaVersion: SCHEMA_VERSION,
      series: [series()],
      runs: [run()]
    };

    writeState(file, written);
    const result = readState(file);

    assert.deepEqual(result.state, written);
    assert.equal(result.migratedFrom, undefined);
  });

  it('should_upgrade_a_v1_schedule_on_read', () => {
    // v1 overloaded `enabled: false` to mean "this one-shot already fired".
    const v1 = {
      schemaVersion: 1,
      series: [series({ enabled: false, recurrence: null })],
      runs: [run()]
    };
    fs.writeFileSync(file, JSON.stringify(v1), 'utf8');

    const result = readState(file);

    assert.equal(result.migratedFrom, 1);
    assert.equal(result.state.schemaVersion, SCHEMA_VERSION);
    assert.equal(result.state.series[0].enabled, true);
    assert.equal(result.state.series[0].spent, true);
  });

  it('should_write_an_upgraded_schedule_back_so_it_migrates_only_once', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, series: [series()], runs: [] }),
      'utf8'
    );

    readState(file);
    const second = readState(file);

    assert.equal(second.migratedFrom, undefined);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, SCHEMA_VERSION);
  });

  it('should_back_up_unparseable_json_rather_than_discarding_it', () => {
    fs.writeFileSync(file, '{ not json at all', 'utf8');

    const result = readState(file);

    assert.deepEqual(result.state, emptyState());
    assert.equal(result.backedUpTo, `${file}.bak`);
    assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), '{ not json at all');
  });

  it('should_back_up_a_schedule_from_a_newer_synchrony_rather_than_guessing_at_it', () => {
    const future = JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, series: [], runs: [] });
    fs.writeFileSync(file, future, 'utf8');

    const result = readState(file);

    assert.deepEqual(result.state, emptyState());
    assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), future);
  });
});

describe('writeState', () => {
  it('should_leave_no_temp_file_behind', () => {
    writeState(file, emptyState());

    assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  });

  it('should_not_write_through_a_name_another_window_could_be_using', () => {
    // The shared `${file}.tmp` path is what a second window would be writing.
    // Touching it at all is the collision that empties somebody's schedule.
    const sentinel = `${file}.tmp`;
    fs.writeFileSync(sentinel, 'another window is mid-write', 'utf8');

    writeState(file, emptyState());

    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'another window is mid-write');
    assert.deepEqual(readState(file).state, emptyState());
  });

  it('should_replace_a_previous_schedule_completely', () => {
    // A shorter write must not leave the tail of the longer one behind, which
    // is exactly what an in-place overwrite would risk.
    writeState(file, { schemaVersion: SCHEMA_VERSION, series: [series()], runs: [run()] });

    writeState(file, emptyState());

    assert.deepEqual(readState(file).state, emptyState());
  });
});

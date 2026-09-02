import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { holdLock, readLock, releaseLock } from '../src/lock';

/**
 * The lock that stops two VS Code windows scheduling the same task twice.
 * Exercised against a real temp directory, because the file *is* the mechanism —
 * mocking `fs` here would test the mock.
 */

const NOW = Date.parse('2026-07-26T12:00:00.000Z');
const STALE_MS = 90_000;

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronos-lock-'));
  file = path.join(dir, 'scheduler.lock');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('lock — claiming', () => {
  it('should_grant_the_lock_when_no_one_holds_it', () => {
    assert.equal(holdLock(file, 'window-a', NOW, STALE_MS), true);
    assert.equal(readLock(file)?.owner, 'window-a');
  });

  it('should_refuse_a_second_window_while_the_holder_is_alive', () => {
    holdLock(file, 'window-a', NOW, STALE_MS);

    assert.equal(holdLock(file, 'window-b', NOW + 30_000, STALE_MS), false);
    assert.equal(readLock(file)?.owner, 'window-a', 'the holder is left undisturbed');
  });

  it('should_keep_granting_the_lock_to_the_window_that_already_holds_it', () => {
    holdLock(file, 'window-a', NOW, STALE_MS);

    assert.equal(holdLock(file, 'window-a', NOW + 30_000, STALE_MS), true);
    assert.equal(readLock(file)?.heartbeatAt, NOW + 30_000, 'the heartbeat moves forward');
  });

  it('should_hand_the_lock_to_another_window_once_the_holder_stops_renewing', () => {
    // A window that closed without releasing, or a machine that slept: waited
    // out rather than deadlocking the schedule forever.
    holdLock(file, 'window-a', NOW, STALE_MS);

    assert.equal(holdLock(file, 'window-b', NOW + STALE_MS + 1, STALE_MS), true);
    assert.equal(readLock(file)?.owner, 'window-b');
  });

  it('should_not_hand_over_a_lock_that_is_exactly_at_the_staleness_edge', () => {
    holdLock(file, 'window-a', NOW, STALE_MS);

    assert.equal(holdLock(file, 'window-b', NOW + STALE_MS, STALE_MS), false);
  });
});

describe('lock — damaged and missing files', () => {
  it('should_treat_an_unparseable_lock_as_unheld', () => {
    fs.writeFileSync(file, 'not json at all', 'utf8');

    assert.equal(readLock(file), undefined);
    assert.equal(holdLock(file, 'window-a', NOW, STALE_MS), true);
  });

  it('should_treat_a_lock_missing_its_fields_as_unheld', () => {
    fs.writeFileSync(file, JSON.stringify({ owner: 'window-a' }), 'utf8');

    assert.equal(readLock(file), undefined);
    assert.equal(holdLock(file, 'window-b', NOW, STALE_MS), true);
  });

  it('should_report_no_holder_for_a_file_that_does_not_exist', () => {
    assert.equal(readLock(file), undefined);
  });

  it('should_decline_to_schedule_when_the_lock_cannot_be_written', () => {
    // No directory means no way to coordinate. A skipped tick is recoverable;
    // two windows editing one repository is not.
    const unwritable = path.join(dir, 'missing-dir', 'scheduler.lock');

    assert.equal(holdLock(unwritable, 'window-a', NOW, STALE_MS), false);
  });
});

describe('lock — releasing', () => {
  it('should_free_the_lock_so_the_next_window_takes_over_immediately', () => {
    holdLock(file, 'window-a', NOW, STALE_MS);

    releaseLock(file, 'window-a');

    assert.equal(readLock(file), undefined);
    assert.equal(holdLock(file, 'window-b', NOW + 1, STALE_MS), true);
  });

  it('should_never_release_a_lock_held_by_another_window', () => {
    holdLock(file, 'window-a', NOW, STALE_MS);

    releaseLock(file, 'window-b');

    assert.equal(readLock(file)?.owner, 'window-a');
  });

  it('should_leave_a_lock_alone_when_another_window_has_taken_it_over', () => {
    // What a suspended window wakes up to: it once held this, but its heartbeat
    // went stale and window-b claimed it fairly. Releasing must not delete
    // window-b's claim, or both windows go on scheduling this folder.
    fs.writeFileSync(file, JSON.stringify({ owner: 'window-b', heartbeatAt: NOW }), 'utf8');

    releaseLock(file, 'window-a');

    assert.equal(fs.existsSync(file), true, 'the lock file survives');
    assert.equal(readLock(file)?.owner, 'window-b', 'and still names its holder');
  });

  it('should_do_nothing_when_releasing_a_lock_that_is_already_gone', () => {
    assert.doesNotThrow(() => releaseLock(file, 'window-a'));
  });
});

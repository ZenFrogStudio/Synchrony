import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  claimCommand,
  commandStatus,
  finishCommand,
  listUnclaimed,
  peekUnclaimed,
  readOutcome,
  writeCommand
} from '../src/control';

/**
 * The control file is the whole protocol between a remote caller and a live
 * window, so these run against a real temp directory: a mocked `fs` would not
 * prove the renames are the exclusive claim they are meant to be.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synchrony-control-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('control — writing and listing', () => {
  it('should_write_an_unclaimed_command_that_lists_oldest_first', () => {
    const a = writeCommand(dir, { kind: 'cancelRun', runId: 'run-a', id: '000001' });
    const b = writeCommand(dir, { kind: 'updateSetting', key: 'maxConcurrent', value: 2, id: '000002' });

    assert.deepEqual(listUnclaimed(dir), [a.id, b.id]);
    assert.equal(commandStatus(dir, a.id), 'unclaimed');
  });

  it('should_list_nothing_for_a_folder_that_has_no_control_dir', () => {
    assert.deepEqual(listUnclaimed(path.join(dir, 'missing')), []);
  });
});

describe('control — peeking', () => {
  it('should_read_an_unclaimed_command_without_claiming_it', () => {
    const written = writeCommand(dir, { kind: 'cancelRun', runId: 'run-a' });

    const peeked = peekUnclaimed(dir, written.id);

    assert.deepEqual(peeked, written);
    assert.equal(commandStatus(dir, written.id), 'unclaimed', 'peeking must not claim');
  });

  it('should_return_undefined_for_a_command_that_does_not_exist', () => {
    assert.equal(peekUnclaimed(dir, 'nope'), undefined);
  });

  it('should_return_undefined_for_a_malformed_command_rather_than_throw', () => {
    fs.writeFileSync(path.join(dir, 'bad001.json'), '{ not json', 'utf8');

    assert.equal(peekUnclaimed(dir, 'bad001'), undefined);
  });
});

describe('control — claiming', () => {
  it('should_let_exactly_one_claimant_win', () => {
    const { id } = writeCommand(dir, { kind: 'cancelRun', runId: 'run-a' });

    const first = claimCommand(dir, id);
    const second = claimCommand(dir, id);

    assert.equal(first.claimed, true);
    assert.equal(second.claimed, false);
    assert.equal(commandStatus(dir, id), 'claimed');
    assert.deepEqual(listUnclaimed(dir), []);
  });

  it('should_hand_the_winner_the_command_body', () => {
    const { id } = writeCommand(dir, { kind: 'updateSetting', key: 'maxConcurrent', value: 3 });
    const won = claimCommand(dir, id);

    assert.equal(won.claimed, true);
    if (won.claimed) {
      assert.equal(won.command.id, id);
      assert.equal(won.command.kind, 'updateSetting');
      if (won.command.kind === 'updateSetting') {
        assert.equal(won.command.key, 'maxConcurrent');
        assert.equal(won.command.value, 3);
      }
    }
  });

  it('should_mark_a_corrupt_command_done_rather_than_leave_it_claimable', () => {
    fs.writeFileSync(path.join(dir, 'bad001.json'), '{ not json', 'utf8');

    const result = claimCommand(dir, 'bad001');

    assert.deepEqual(result, { claimed: false, reason: 'unreadable' });
    assert.equal(commandStatus(dir, 'bad001'), 'done');
    assert.equal(readOutcome(dir, 'bad001')?.outcome.ok, false);
  });

  it('should_mark_an_unknown_kind_done_rather_than_leave_it_claimable', () => {
    fs.writeFileSync(
      path.join(dir, 'weird01.json'),
      JSON.stringify({ id: 'weird01', kind: 'reboot', requestedAt: new Date().toISOString() }),
      'utf8'
    );

    const result = claimCommand(dir, 'weird01');

    assert.deepEqual(result, { claimed: false, reason: 'unreadable' });
    assert.equal(readOutcome(dir, 'weird01')?.outcome.ok, false);
  });
});

describe('control — finishing', () => {
  it('should_record_the_outcome_and_remove_the_claimed_file', () => {
    const { id } = writeCommand(dir, { kind: 'cancelRun', runId: 'run-a' });
    claimCommand(dir, id);

    finishCommand(dir, id, { ok: true });

    assert.equal(commandStatus(dir, id), 'done');
    const done = readOutcome(dir, id);
    assert.equal(done?.kind, 'cancelRun');
    assert.equal(done?.outcome.ok, true);
    assert.ok(done?.outcome.finishedAt);
  });

  it('should_carry_a_note_through_to_the_outcome', () => {
    const { id } = writeCommand(dir, { kind: 'cancelRun', runId: 'run-a' });
    claimCommand(dir, id);

    finishCommand(dir, id, { ok: false, note: 'no live window owns that run' });

    assert.equal(readOutcome(dir, id)?.outcome.ok, false);
    assert.equal(readOutcome(dir, id)?.outcome.note, 'no live window owns that run');
  });
});

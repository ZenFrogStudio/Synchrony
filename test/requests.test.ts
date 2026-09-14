import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  claimRequest,
  finishRequest,
  isTaskName,
  listUnclaimed,
  readOutcome,
  refuseExcess,
  requestStatus,
  writeRequest
} from '../src/requests';

/**
 * The request file is the whole protocol between a remote caller and a live
 * window, so these run against a real temp directory: a mocked `fs` would not
 * prove the renames are the exclusive claim they are meant to be.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synchrony-requests-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('requests — naming', () => {
  it('should_accept_a_bare_markdown_file_name', () => {
    assert.equal(isTaskName('fix-the-lock.md'), true);
  });

  it('should_refuse_anything_that_could_leave_the_inbox', () => {
    for (const bad of ['../plans/x.md', 'sub/x.md', 'x.txt', '.hidden.md', '', 42, null]) {
      assert.equal(isTaskName(bad), false, JSON.stringify(bad));
    }
  });
});

describe('requests — writing and listing', () => {
  it('should_write_an_unclaimed_request_that_lists_oldest_first', () => {
    const a = writeRequest(dir, { task: 'a.md', id: '000001' });
    const b = writeRequest(dir, { task: 'b.md', id: '000002', series: true, model: 'm' });

    assert.deepEqual(listUnclaimed(dir), [a.id, b.id]);
    assert.equal(b.series, true);
    assert.equal(b.model, 'm');
    assert.equal(requestStatus(dir, a.id), 'unclaimed');
  });

  it('should_refuse_to_write_a_request_for_a_path', () => {
    assert.throws(() => writeRequest(dir, { task: '../escape.md' }));
    assert.deepEqual(listUnclaimed(dir), []);
  });

  it('should_list_nothing_for_a_folder_that_has_no_requests_dir', () => {
    assert.deepEqual(listUnclaimed(path.join(dir, 'missing')), []);
  });
});

describe('requests — claiming', () => {
  it('should_let_exactly_one_claimant_win', () => {
    const { id } = writeRequest(dir, { task: 'a.md' });

    const first = claimRequest(dir, id);
    const second = claimRequest(dir, id);

    assert.equal(first.claimed, true);
    assert.equal(second.claimed, false);
    assert.equal(requestStatus(dir, id), 'claimed');
    assert.deepEqual(listUnclaimed(dir), []);
  });

  it('should_hand_the_winner_the_request_body', () => {
    const { id } = writeRequest(dir, { task: 'a.md', series: true });
    const won = claimRequest(dir, id);
    assert.equal(won.claimed, true);
    if (won.claimed) {
      assert.equal(won.request.task, 'a.md');
      assert.equal(won.request.series, true);
      assert.equal(won.request.id, id);
    }
  });

  it('should_mark_a_corrupt_request_done_rather_than_leave_it_claimable', () => {
    fs.writeFileSync(path.join(dir, 'bad001.json'), '{ not json', 'utf8');

    const result = claimRequest(dir, 'bad001');

    assert.deepEqual(result, { claimed: false, reason: 'unreadable' });
    assert.equal(requestStatus(dir, 'bad001'), 'done');
    assert.equal(readOutcome(dir, 'bad001')?.outcome.ok, false);
  });
});

describe('requests — finishing', () => {
  it('should_record_the_outcome_and_remove_the_claimed_file', () => {
    const { id } = writeRequest(dir, { task: 'a.md' });
    claimRequest(dir, id);

    finishRequest(dir, id, { ok: true, note: 'session opened' });

    assert.equal(requestStatus(dir, id), 'done');
    const done = readOutcome(dir, id);
    assert.equal(done?.task, 'a.md', 'the original body is kept');
    assert.equal(done?.outcome.ok, true);
    assert.equal(done?.outcome.note, 'session opened');
    assert.ok(done?.outcome.finishedAt);
  });
});

describe('requests — refusing excess', () => {
  it('should_refuse_the_newest_beyond_the_cap_and_leave_the_oldest_unclaimed', () => {
    const ids = ['000001', '000002', '000003', '000004', '000005', '000006', '000007'];
    for (const id of ids) writeRequest(dir, { task: 'a.md', id });

    const refused = refuseExcess(dir, 5);

    assert.deepEqual(refused, ['000006', '000007']);
    for (const id of refused) {
      assert.equal(requestStatus(dir, id), 'done');
      const done = readOutcome(dir, id);
      assert.equal(done?.outcome.ok, false);
      assert.ok(done?.outcome.note);
    }
    assert.deepEqual(listUnclaimed(dir), ids.slice(0, 5));
  });

  it('should_refuse_nothing_when_fewer_than_the_cap_are_pending', () => {
    const ids = ['000001', '000002', '000003'];
    for (const id of ids) writeRequest(dir, { task: 'a.md', id });

    assert.deepEqual(refuseExcess(dir, 5), []);
    assert.deepEqual(listUnclaimed(dir), ids);
  });

  it('should_refuse_nothing_for_a_folder_that_has_no_requests_dir', () => {
    assert.deepEqual(refuseExcess(path.join(dir, 'missing'), 5), []);
  });
});

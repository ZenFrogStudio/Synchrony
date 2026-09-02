import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { armings, chainPatches, downstream, isInChain, spliceChain, wouldCycle } from '../src/chain';
import { Action } from '../src/decide';
import { TaskRun, TaskSeries } from '../src/types';

/**
 * Chains, tested without a clock, a store or an editor — the arming rule runs on
 * every scheduler tick, and a mistake in it either fires a plan twice or leaves
 * the rest of a chain parked forever with nothing anywhere to say why.
 */

const NOW = Date.parse('2026-07-26T12:00:00.000Z');
const MINUTE = 60_000;

function series(overrides: Partial<TaskSeries> = {}): TaskSeries {
  return {
    id: 'head',
    filePath: 'D:\\plans\\audit.md',
    fileName: 'audit.md',
    cwd: 'D:\\repo',
    permissionMode: 'auto',
    recurrence: null,
    nextRunAt: new Date(NOW).toISOString(),
    enabled: true,
    maxRetries: 3,
    createdAt: new Date(NOW).toISOString(),
    ...overrides
  };
}

/** A plan parked behind another one, which is how a follower waits. */
function follower(overrides: Partial<TaskSeries> = {}): TaskSeries {
  return series({
    id: 'next',
    fileName: 'review.md',
    spent: true,
    chain: { after: 'head', delayMinutes: 15, stopOnFailure: true },
    ...overrides
  });
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run-1',
    seriesId: 'head',
    scheduledAt: new Date(NOW - 60 * MINUTE).toISOString(),
    status: 'completed',
    attempt: 1,
    finishedAt: new Date(NOW - 30 * MINUTE).toISOString(),
    ...overrides
  };
}

const patchFor = (actions: Action[], id: string) =>
  actions.flatMap((a) => (a.kind === 'updateSeries' && a.id === id ? [a.patch] : []));
const announcements = (actions: Action[]) => actions.filter((a) => a.kind === 'announceBroken');

describe('chain — arming the next plan', () => {
  it('should_arm_a_follower_once_the_plan_before_it_completes', () => {
    const actions = armings([series(), follower()], [run()], NOW);

    const patches = patchFor(actions, 'next');
    assert.equal(patches.length, 1);
    assert.equal(patches[0].spent, false);
    assert.ok(patches[0].nextRunAt);
  });

  it('should_wait_the_gap_after_the_plan_before_it_finished', () => {
    // Finished 30 minutes ago with a 45 minute gap: still 15 minutes to go.
    const actions = armings(
      [series(), follower({ chain: { after: 'head', delayMinutes: 45, stopOnFailure: true } })],
      [run()],
      NOW
    );

    const armed = Date.parse(patchFor(actions, 'next')[0].nextRunAt as string);
    assert.equal(armed, NOW - 30 * MINUTE + 45 * MINUTE);
  });

  it('should_never_arm_into_the_past', () => {
    // The trigger is the plan before it *finishing*, not a time of day. A chain
    // whose head completed overnight carries on when the window reopens rather
    // than being marked missed for a time it was never waiting for.
    const overnight = run({
      scheduledAt: new Date(NOW - 20 * 60 * MINUTE).toISOString(),
      finishedAt: new Date(NOW - 19 * 60 * MINUTE).toISOString()
    });

    const actions = armings([series(), follower()], [overnight], NOW);

    assert.equal(Date.parse(patchFor(actions, 'next')[0].nextRunAt as string), NOW);
  });

  it('should_not_arm_before_the_plan_before_it_has_run', () => {
    assert.deepEqual(armings([series(), follower()], [], NOW), []);
  });

  it('should_not_arm_while_a_retry_is_still_queued', () => {
    // A failed run queues a retry an hour out. Reading the failure as the
    // outcome would stop the chain while the plan still has attempts left.
    const failed = run({ status: 'failed' });
    const retry = run({ id: 'run-2', status: 'pending', attempt: 2, finishedAt: undefined });

    assert.deepEqual(armings([series(), follower()], [failed, retry], NOW), []);
  });

  it('should_not_arm_a_follower_that_has_already_had_its_turn', () => {
    // The idempotency check. Without it the follower is armed again on every
    // tick — a plan running every thirty seconds, forever.
    const own = run({
      id: 'run-2',
      seriesId: 'next',
      scheduledAt: new Date(NOW - 15 * MINUTE).toISOString(),
      finishedAt: new Date(NOW - 5 * MINUTE).toISOString()
    });

    assert.deepEqual(armings([series(), follower()], [run(), own], NOW), []);
  });

  it('should_arm_it_again_when_the_plan_before_it_runs_again', () => {
    // What makes "Run now" on the head re-run the whole chain.
    const first = run({ finishedAt: new Date(NOW - 3 * 60 * MINUTE).toISOString() });
    const own = run({
      id: 'run-2',
      seriesId: 'next',
      scheduledAt: new Date(NOW - 2 * 60 * MINUTE).toISOString(),
      finishedAt: new Date(NOW - 100 * MINUTE).toISOString()
    });
    const again = run({ id: 'run-3', finishedAt: new Date(NOW - MINUTE).toISOString() });

    const actions = armings([series(), follower()], [first, own, again], NOW);

    assert.equal(patchFor(actions, 'next').length, 1);
  });

  it('should_ignore_a_follower_the_user_has_paused', () => {
    assert.deepEqual(armings([series(), follower({ enabled: false })], [run()], NOW), []);
  });

  it('should_ignore_a_follower_that_is_not_parked', () => {
    // Already armed and waiting for its time to come round.
    assert.deepEqual(armings([series(), follower({ spent: false })], [run()], NOW), []);
  });

  it('should_leave_an_ordinary_plan_alone', () => {
    assert.deepEqual(armings([series()], [run()], NOW), []);
  });

  it('should_never_arm_a_parked_plan_that_carries_no_link', () => {
    // What makes clearing `chain` on retirement enough on its own. A retired
    // plan keeps `spent: true` and `enabled: true` — spent is how a follower
    // waits — so the link is the only thing left saying it is still in a chain.
    // Without it, nothing the plan before it does can arm it out of the archive.
    const retired = follower({ chain: undefined });

    for (const outcome of [run(), run({ status: 'failed' }), run({ status: 'cancelled' })]) {
      assert.deepEqual(armings([series(), retired], [outcome], NOW), []);
    }
  });
});

describe('chain — a plan that does not finish cleanly', () => {
  it('should_stop_the_chain_when_told_to', () => {
    const actions = armings([series(), follower()], [run({ status: 'failed' })], NOW);

    assert.deepEqual(patchFor(actions, 'next'), [{ enabled: false }]);
    assert.equal(announcements(actions).length, 1);
  });

  it('should_stop_the_chain_on_a_missed_run_too', () => {
    const missed = run({ status: 'missed', finishedAt: undefined, missedAt: new Date(NOW).toISOString() });

    const actions = armings([series(), follower()], [missed], NOW);

    assert.deepEqual(patchFor(actions, 'next'), [{ enabled: false }]);
  });

  it('should_carry_on_past_a_failure_when_told_to', () => {
    const carryOn = follower({
      chain: { after: 'head', delayMinutes: 15, stopOnFailure: false }
    });

    const actions = armings([series(), carryOn], [run({ status: 'failed' })], NOW);

    assert.equal(patchFor(actions, 'next')[0].spent, false);
  });

  it('should_switch_off_everything_behind_a_stopped_link', () => {
    // The plan two steps down waits on one that is never going to run. Left
    // parked it would sit there forever with nothing saying why.
    const third = follower({
      id: 'third',
      fileName: 'deploy.md',
      chain: { after: 'next', delayMinutes: 5, stopOnFailure: true }
    });

    const actions = armings([series(), follower(), third], [run({ status: 'failed' })], NOW);

    assert.deepEqual(patchFor(actions, 'third'), [{ enabled: false }]);
  });

  it('should_announce_a_stopped_chain_only_once', () => {
    // Switching the follower off is what makes this true: the rule needs
    // `enabled`, so the next tick does not reach the branch again. Otherwise the
    // notification fires every thirty seconds for as long as the window is open.
    const stopped = follower({ enabled: false });

    assert.deepEqual(armings([series(), stopped], [run({ status: 'failed' })], NOW), []);
  });

  it('should_name_the_plan_that_stopped_the_chain', () => {
    const actions = armings([series(), follower()], [run({ status: 'failed' })], NOW);

    const announced = announcements(actions)[0];
    assert.ok(announced.kind === 'announceBroken');
    assert.equal(announced.fileName, 'review.md');
    assert.match(announced.problem, /audit\.md/);
  });

  it('should_keep_waiting_while_an_hourly_recovery_retry_is_queued', () => {
    // The plan before it ran out of ordinary attempts and is now retrying on the
    // hour until the outage passes. Reading that exhausted failure as the
    // outcome is exactly what used to take the rest of the night down with it.
    const failed = run({ status: 'failed', attempt: 4 });
    const recovery = run({
      id: 'run-2',
      status: 'pending',
      attempt: 5,
      chainRecovery: true,
      scheduledAt: new Date(NOW + 40 * MINUTE).toISOString(),
      finishedAt: undefined
    });

    assert.deepEqual(armings([series(), follower()], [failed, recovery], NOW), []);
  });

  it('should_carry_on_once_a_recovery_retry_finally_completes', () => {
    const failed = run({ status: 'failed', attempt: 4 });
    const recovered = run({
      id: 'run-2',
      attempt: 5,
      chainRecovery: true,
      finishedAt: new Date(NOW - 5 * MINUTE).toISOString()
    });

    const patches = patchFor(armings([series(), follower()], [failed, recovered], NOW), 'next');

    assert.equal(patches.length, 1);
    assert.equal(patches[0].spent, false);
  });

  it('should_switch_off_a_follower_whose_predecessor_is_gone', () => {
    const orphan = follower({ chain: { after: 'deleted', delayMinutes: 15, stopOnFailure: true } });

    const actions = armings([orphan], [], NOW);

    assert.deepEqual(patchFor(actions, 'next'), [{ enabled: false }]);
    assert.equal(announcements(actions).length, 1);
  });
});

describe('chain — building one', () => {
  const built = chainPatches(['a', 'b', 'c'], new Date(NOW).toISOString(), 15, true);

  it('should_give_the_first_plan_the_start_time_and_no_link', () => {
    assert.equal(built[0].id, 'a');
    assert.equal(built[0].patch.nextRunAt, new Date(NOW).toISOString());
    assert.equal(built[0].patch.chain, undefined);
    assert.equal(built[0].patch.spent, false);
  });

  it('should_park_every_other_plan_behind_the_one_before_it', () => {
    assert.deepEqual(built[1].patch.chain, { after: 'a', delayMinutes: 15, stopOnFailure: true });
    assert.deepEqual(built[2].patch.chain, { after: 'b', delayMinutes: 15, stopOnFailure: true });
    assert.equal(built[1].patch.spent, true);
    assert.equal(built[2].patch.spent, true);
  });

  it('should_clear_any_repeat_rule_the_plans_were_carrying', () => {
    // A chain is one-shot. A plan cannot be driven by the clock and by the plan
    // before it at the same time.
    for (const { patch } of built) {
      assert.equal(patch.recurrence, null);
    }
  });
});

describe('chain — closing a gap', () => {
  const head = series({ id: 'a' });
  const middle = series({ id: 'b', chain: { after: 'a', delayMinutes: 15, stopOnFailure: true } });
  const last = series({ id: 'c', chain: { after: 'b', delayMinutes: 5, stopOnFailure: false } });

  it('should_hand_a_follower_the_removed_plans_own_predecessor', () => {
    const patches = spliceChain([head, middle, last], 'b');

    assert.equal(patches.length, 1);
    assert.equal(patches[0].id, 'c');
    assert.equal(patches[0].patch.chain?.after, 'a');
  });

  it('should_keep_the_followers_own_gap_and_failure_rule', () => {
    const patches = spliceChain([head, middle, last], 'b');

    assert.equal(patches[0].patch.chain?.delayMinutes, 5);
    assert.equal(patches[0].patch.chain?.stopOnFailure, false);
  });

  it('should_unlink_and_switch_off_a_follower_of_the_first_plan', () => {
    // There is no link to inherit. Promoting it to the head's old clock time
    // would put a plan on the schedule the user never scheduled.
    const patches = spliceChain([head, middle, last], 'a');

    assert.deepEqual(patches, [{ id: 'b', patch: { chain: undefined, enabled: false } }]);
  });

  it('should_leave_a_chain_alone_when_something_outside_it_is_removed', () => {
    assert.deepEqual(spliceChain([head, middle, last], 'elsewhere'), []);
  });
});

describe('chain — walking it', () => {
  const a = series({ id: 'a' });
  const b = series({ id: 'b', chain: { after: 'a', delayMinutes: 1, stopOnFailure: true } });
  const c = series({ id: 'c', chain: { after: 'b', delayMinutes: 1, stopOnFailure: true } });
  const loose = series({ id: 'loose' });

  it('should_find_every_plan_behind_one_however_far_back', () => {
    assert.deepEqual(
      downstream([a, b, c, loose], 'a').map((s) => s.id),
      ['b', 'c']
    );
  });

  it('should_recognise_a_chain_from_either_end', () => {
    // The head carries no link of its own, so the only sign it is in a chain is
    // that something else waits on it. `retry.ts` reads this to decide whether a
    // failure is worth retrying past `maxRetries`.
    assert.equal(isInChain([a, b, c, loose], 'a'), true);
    assert.equal(isInChain([a, b, c, loose], 'b'), true);
    assert.equal(isInChain([a, b, c, loose], 'loose'), false);
  });

  it('should_refuse_a_link_that_would_make_a_loop', () => {
    // Neither end could ever be armed: each would be waiting on the other.
    assert.equal(wouldCycle([a, b, c], 'a', 'c'), true);
    assert.equal(wouldCycle([a, b, c], 'a', 'a'), true);
  });

  it('should_allow_a_link_that_does_not', () => {
    assert.equal(wouldCycle([a, b, c, loose], 'loose', 'c'), false);
  });
});

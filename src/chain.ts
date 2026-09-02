import type { Action } from './decide';
import { recency } from './history';
import { TaskRun, TaskSeries } from './types';

/**
 * Chains: several plans run one after another, each armed by the one before it
 * finishing rather than by a clock time.
 *
 * Pure — no `vscode`, no store, no clock — like `decide.ts` and `recurrence.ts`,
 * so every rule below is a unit test rather than something only a live schedule
 * could show up.
 *
 * The arming rule is deliberately *declarative*: it reads the current series and
 * runs on every tick and works out what should be armed, rather than hanging off
 * the runner's "a run finished" event. That is what makes a chain survive a
 * closed window — if the plan before finished while VS Code was shut, the next
 * tick still notices and carries on, instead of the rest of the chain sitting
 * parked forever waiting for an event that already happened.
 *
 * A parked follower waits as `spent`, not as `enabled: false`. `spent` already
 * means "no occurrence is pending", which is exactly what waiting is, and it
 * leaves `enabled` as the one thing it has always been: the user's pause. It
 * also means a chained one-shot re-parks itself for free — `advanceOf` in
 * `decide.ts` marks a fired one-shot spent, which is the waiting state again.
 */

/** A patch to apply to one series. What the callers of the helpers here get. */
export interface SeriesPatch {
  id: string;
  patch: Partial<TaskSeries>;
}

const MINUTE_MS = 60_000;

/**
 * The plans that should be armed on this tick, and the chains that have stopped.
 *
 * Called by `decide` before it turns due occurrences into runs, so a plan armed
 * here can start on the same tick rather than waiting for the next one.
 */
export function armings(
  series: readonly TaskSeries[],
  runs: readonly TaskRun[],
  nowMs: number
): Action[] {
  const actions: Action[] = [];
  const byId = new Map(series.map((s) => [s.id, s]));
  // Filled as the loop goes, so a chain that stops takes its whole tail with it
  // even when the tail is visited first.
  const stopped = new Set<string>();

  for (const follower of series) {
    const link = follower.chain;
    if (!link || !follower.enabled || !follower.spent || stopped.has(follower.id)) {
      continue;
    }

    const before = byId.get(link.after);
    if (!before) {
      // The plan this one waits on has been deleted outright. `spliceChain`
      // normally closes the gap first, so this is the case where it could not —
      // and a follower left waiting on nothing waits forever.
      actions.push({ kind: 'updateSeries', id: follower.id, patch: { enabled: false } });
      actions.push({
        kind: 'announceBroken',
        fileName: follower.fileName,
        problem: 'the plan it runs after is gone'
      });
      continue;
    }

    const own = runs.filter((r) => r.seriesId === before.id);

    // A failed run queues a retry an hour out. The chain waits for the retry
    // rather than treating the first failure as the outcome.
    if (own.some((r) => r.status === 'pending' || r.status === 'running')) {
      continue;
    }

    const last = newestFinished(own);
    if (!last) {
      continue;
    }

    const finishedAtMs = Date.parse(recency(last));
    if (Number.isNaN(finishedAtMs)) {
      continue;
    }

    // Whether this follower has already had its turn for this run of the chain.
    // Compared against the predecessor's finish rather than against the armed
    // time, which is clamped to `now` below and would otherwise creep forward on
    // every tick and re-arm the follower endlessly.
    const alreadyRan = runs.some(
      (r) => r.seriesId === follower.id && Date.parse(r.scheduledAt) >= finishedAtMs
    );
    if (alreadyRan) {
      continue;
    }

    if (last.status !== 'completed' && link.stopOnFailure) {
      // Switched off rather than merely left parked, and that is what makes the
      // notification fire once: the rule above needs `enabled`, so the next tick
      // does not reach this branch again. Everything behind it goes too, or it
      // would sit waiting on a plan that is never going to run.
      for (const id of [follower.id, ...downstream(series, follower.id).map((s) => s.id)]) {
        stopped.add(id);
        actions.push({ kind: 'updateSeries', id, patch: { enabled: false } });
      }
      actions.push({
        kind: 'announceBroken',
        fileName: follower.fileName,
        problem: `the plan it runs after (${before.fileName}) ${outcomeWord(last)}`
      });
      continue;
    }

    // Never armed into the past. The trigger is the plan before it *finishing*,
    // not a time of day — so a chain whose head completed overnight carries on
    // when the window reopens, rather than being marked missed for a time it was
    // never really waiting for.
    const armAt = Math.max(finishedAtMs + link.delayMinutes * MINUTE_MS, nowMs);
    actions.push({
      kind: 'updateSeries',
      id: follower.id,
      patch: { spent: false, nextRunAt: new Date(armAt).toISOString() }
    });
  }

  return actions;
}

/**
 * Turns an ordered list of series into a chain: the first one starts the whole
 * thing at a clock time, and each of the rest waits on the one before it.
 *
 * Chains are one-shot, so every link's repeat rule is cleared — a plan cannot
 * be both driven by the clock and driven by the plan before it.
 */
export function chainPatches(
  ids: readonly string[],
  startIso: string,
  gapMinutes: number,
  stopOnFailure: boolean
): SeriesPatch[] {
  return ids.map((id, index) => ({
    id,
    patch:
      index === 0
        ? {
            nextRunAt: startIso,
            recurrence: null,
            chain: undefined,
            enabled: true,
            spent: false
          }
        : {
            chain: { after: ids[index - 1], delayMinutes: gapMinutes, stopOnFailure },
            recurrence: null,
            enabled: true,
            // Parked: it has no time of its own until the one before it finishes.
            spent: true
          }
  }));
}

/**
 * Closes the gap left by a series being deleted, so its followers are not left
 * waiting on something that no longer exists. A follower of the *head* — which
 * has no link of its own to inherit — is unlinked and switched off rather than
 * silently promoted to running on the head's old clock time.
 */
export function spliceChain(series: readonly TaskSeries[], removedId: string): SeriesPatch[] {
  const removed = series.find((s) => s.id === removedId);
  const inherited = removed?.chain;

  return series
    .filter((s) => s.chain?.after === removedId)
    .map((s) => ({
      id: s.id,
      // Only the predecessor changes: the follower keeps its own gap and its own
      // answer to what should happen if that plan fails.
      patch: inherited
        ? { chain: { ...s.chain!, after: inherited.after } }
        : { chain: undefined, enabled: false }
    }));
}

/**
 * Whether this plan is part of a chain at all — as a follower, which carries the
 * link, or as the head, which does not and is only identifiable by something
 * else waiting on it.
 *
 * Read by `retry.ts`: a failure inside a chain stops more than itself, so it is
 * worth more attempts than a plan that fails alone.
 */
export function isInChain(series: readonly TaskSeries[], id: string): boolean {
  return series.some((s) => (s.id === id && s.chain) || s.chain?.after === id);
}

/** Every series behind this one in the chain, however far back. */
export function downstream(series: readonly TaskSeries[], id: string): TaskSeries[] {
  const found: TaskSeries[] = [];
  const seen = new Set([id]);
  let frontier = [id];

  while (frontier.length) {
    const next = series.filter((s) => s.chain && frontier.includes(s.chain.after) && !seen.has(s.id));
    for (const s of next) {
      seen.add(s.id);
      found.push(s);
    }
    frontier = next.map((s) => s.id);
  }

  return found;
}

/**
 * Whether linking `id` behind `after` would make a loop — A after B after A,
 * where neither could ever be armed because each waits on the other.
 */
export function wouldCycle(series: readonly TaskSeries[], id: string, after: string): boolean {
  return after === id || downstream(series, id).some((s) => s.id === after);
}

/** The newest run of a series that is over, whatever became of it. */
function newestFinished(runs: readonly TaskRun[]): TaskRun | undefined {
  return runs
    .filter((r) => r.status !== 'pending' && r.status !== 'running')
    .sort((a, b) => recency(b).localeCompare(recency(a)))[0];
}

function outcomeWord(run: TaskRun): string {
  if (run.status === 'missed') {
    return 'was missed';
  }
  return run.status === 'cancelled' ? 'was cancelled' : 'failed';
}

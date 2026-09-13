import { isInChain } from './chain';
import { TaskRun, TaskSeries } from './types';

/**
 * What happens after a run fails. Pure — no `vscode`, no store, no clock — like
 * `decide.ts` and `chain.ts`, so every rule below is a unit test rather than
 * something only a real overnight failure could show up.
 *
 * Two policies live here. An ordinary plan retries a bounded number of times and
 * then reports, which is what `maxRetries` has always meant. A plan inside a
 * chain does that too, and then keeps trying every hour on the hour instead of
 * giving up straight away: the failure that actually happens overnight is a
 * temporary one — credits run out, a session limit is hit — and a chain that
 * stops there takes every plan behind it down with it until somebody notices in
 * the morning. An hourly retry outlives that; a bounded one three hours long
 * does not. The hourly retry has its own, much larger ceiling — see
 * `MAX_RECOVERY_ATTEMPTS` — because "retryable" is wider than an outage: a plan
 * that hangs until the watchdog kills it is retryable too, and one of those
 * retried hourly forever is a billable run every hour against a real repository
 * with nothing ever reported.
 *
 * Only *retryable* failures recover. A cancelled run, a missing plan file, a bad
 * working directory or rejected credentials fail identically forever, so those
 * still stop and report — see `outcome.ts`, which decides which is which.
 */

const HOUR_MS = 3_600_000;

/**
 * Hourly recovery retries a chained plan gets past `maxRetries` before it reports
 * like any other plan. A count of attempts rather than a wall-clock cutoff
 * because it needs no new state: `attempt` already counts every retry, recovery
 * included, whereas a recovery run's `scheduledAt` is its own hour rather than
 * the occurrence the outage began at, so a clock would need that carried across
 * runs. A count also bounds the thing that costs money. A recovery run whose hour
 * passed while the window was shut is moved on by `decide.ts` without running,
 * and without being counted here — so a closed weekend does not spend the budget.
 * Thirty-six attempts an hour apart is a day and a half at the least: long enough
 * to cross an overnight outage and the working day after it, short enough that a
 * plan that is never going to work stops before it has run for weeks.
 */
export const MAX_RECOVERY_ATTEMPTS = 36;

/**
 * The next whole hour after `fromMs`, UTC. Exactly on the hour returns the hour
 * *after*, never the same instant: a recovery retry dated now would fire on the
 * same tick, straight back into the outage it is meant to be waiting out.
 */
export function nextTopOfHour(fromMs: number): string {
  return new Date(Math.floor(fromMs / HOUR_MS) * HOUR_MS + HOUR_MS).toISOString();
}

export type RetryPlan =
  /** Ordinary bounded retry, `synchrony.retryDelayMinutes` out. */
  | { kind: 'retry'; scheduledAt: string; attempt: number }
  /** Attempts exhausted inside a chain: keep going, on the hour. */
  | { kind: 'recovery'; scheduledAt: string; attempt: number }
  /** Nothing left to try. Tell the user. */
  | { kind: 'report' };

export function retryPlan(input: {
  run: TaskRun;
  series: TaskSeries;
  /** Every series, so a chain is recognised from either end. */
  allSeries: readonly TaskSeries[];
  /** From `outcome.ts`: false when retrying cannot plausibly help. */
  retryable: boolean;
  nowMs: number;
  delayMinutes: number;
}): RetryPlan {
  const { run, series, retryable, nowMs } = input;

  if (!retryable) {
    return { kind: 'report' };
  }

  const attempt = run.attempt + 1;
  const retriesUsed = run.attempt - 1;

  if (retriesUsed < series.maxRetries) {
    return {
      kind: 'retry',
      scheduledAt: new Date(nowMs + input.delayMinutes * 60_000).toISOString(),
      attempt
    };
  }

  // Past the ceiling this falls through to `report` like a plan outside a
  // chain, and the chain reads the failure as the outcome it is.
  const recoveriesUsed = retriesUsed - series.maxRetries;
  if (recoveriesUsed < MAX_RECOVERY_ATTEMPTS && isInChain(input.allSeries, series.id)) {
    return { kind: 'recovery', scheduledAt: nextTopOfHour(nowMs), attempt };
  }

  return { kind: 'report' };
}

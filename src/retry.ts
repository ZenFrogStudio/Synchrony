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
 * giving up: the failure that actually happens overnight is a temporary one —
 * credits run out, a session limit is hit — and a chain that stops there takes
 * every plan behind it down with it until somebody notices in the morning. An
 * hourly retry outlives that; a bounded one three hours long does not.
 *
 * Only *retryable* failures recover. A cancelled run, a missing plan file, a bad
 * working directory or rejected credentials fail identically forever, so those
 * still stop and report — see `outcome.ts`, which decides which is which.
 */

const HOUR_MS = 3_600_000;

/**
 * The next whole hour after `fromMs`, UTC. Exactly on the hour returns the hour
 * *after*, never the same instant: a recovery retry dated now would fire on the
 * same tick, straight back into the outage it is meant to be waiting out.
 */
export function nextTopOfHour(fromMs: number): string {
  return new Date(Math.floor(fromMs / HOUR_MS) * HOUR_MS + HOUR_MS).toISOString();
}

export type RetryPlan =
  /** Ordinary bounded retry, `chronos.retryDelayMinutes` out. */
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

  if (isInChain(input.allSeries, series.id)) {
    return { kind: 'recovery', scheduledAt: nextTopOfHour(nowMs), attempt };
  }

  return { kind: 'report' };
}

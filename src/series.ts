import { randomUUID } from 'crypto';
import * as path from 'path';
import { computeNextRun } from './recurrence';
import { nowUtc } from './time';
import { PermissionMode, TaskSeries } from './types';

/**
 * What a newly scheduled task looks like before anyone edits it.
 *
 * No `vscode` import, so the MCP server process can mint a series exactly the
 * way the manager does rather than assembling one of its own — two spellings of
 * "a new series" would drift the moment a field was added. The two genuinely
 * editor-shaped defaults are therefore passed in rather than read here:
 * `maxRetries` comes from `synchrony.maxRetries`, and `cwd` from whichever
 * workspace folder the caller decided owns the plan (`defaultCwd` in
 * `manager.ts` for the editor, the `--folder` for the server).
 */

/** Identity for a series or a run. One place, so nothing invents its own. */
export function newId(): string {
  return randomUUID();
}

/**
 * `auto` rather than `bypassPermissions`: a new task gets the CLI's own
 * judgement about what is safe to do unattended, instead of a blanket waiver.
 * The old default meant unrestricted tool access on a schedule, and one bad
 * plan on a recurring series repeats that indefinitely.
 *
 * The cost is exactly why it used to be `bypassPermissions`. A mode that can
 * still stop and ask has nobody to ask at 3am, so a run may end having done
 * only part of the job. Reviewing the plan before scheduling it is still the
 * real safety step, and `bypassPermissions` stays one click away per task.
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto';

/** The two defaults a caller must decide, because neither is knowable here. */
export interface SeriesDefaults {
  /** Working directory for the agent process. */
  cwd: string;
  maxRetries: number;
}

/** One hour out, rounded up to the next quarter hour. */
export function defaultScheduledAt(from: Date = new Date()): string {
  const target = new Date(from.getTime() + 60 * 60_000);
  target.setSeconds(0, 0);
  const minutes = target.getMinutes();
  target.setMinutes(minutes + ((15 - (minutes % 15)) % 15));
  return target.toISOString();
}

/**
 * Stamps `repeatEndedAt` when a patch takes a repeat rule away, and clears it
 * when a patch puts one back. Applied at every writer of a series so the two
 * processes cannot disagree about when a plan became a one-shot.
 *
 * `retire.ts` reads the stamp to decide whether the completed runs behind a
 * plan were made under a rule it no longer has — a plan switched from Weekly to
 * Once would otherwise be archived on the strength of runs it made while it was
 * still repeating, before its one-shot occurrence ever fired.
 */
export function stampRepeatEnd(
  current: TaskSeries,
  patch: Partial<TaskSeries>,
  now: string = nowUtc()
): Partial<TaskSeries> {
  if (patch.recurrence === null && current.recurrence) {
    return { ...patch, repeatEndedAt: now };
  }
  if (patch.recurrence) {
    // A series that repeats again has no end. `Object.assign` writes the key as
    // `undefined` and `JSON.stringify` drops it, which is how it leaves
    // `state.json` rather than lingering as a stale date.
    return { ...patch, repeatEndedAt: undefined };
  }
  return patch;
}

/**
 * A repeating plan given a time that has already gone means its next occurrence.
 * Picking "Saturday 1:00" at 4:50 on a Saturday is choosing the day and the
 * hour, not asking for a run four hours ago — left as it was, the next scheduler
 * tick would announce a miss nobody had, or run it late if still in the window.
 *
 * Takes the series as it will be after the edit, and returns what to add to the
 * patch. Paused, spent and one-shot plans are left alone: none of them fires.
 */
export function skipPastOccurrence(
  next: TaskSeries,
  now: number = Date.now()
): Partial<TaskSeries> {
  if (!next.recurrence || !next.enabled || next.spent || Date.parse(next.nextRunAt) > now) {
    return {};
  }
  return { nextRunAt: computeNextRun(next.recurrence, new Date(now)).toISOString() };
}

export function createSeries(
  filePath: string,
  defaults: SeriesDefaults,
  overrides: Partial<TaskSeries> = {}
): TaskSeries {
  return {
    id: newId(),
    filePath,
    fileName: path.basename(filePath),
    cwd: defaults.cwd,
    permissionMode: DEFAULT_PERMISSION_MODE,
    recurrence: null,
    nextRunAt: defaultScheduledAt(),
    enabled: true,
    maxRetries: defaults.maxRetries,
    createdAt: nowUtc(),
    ...overrides
  };
}

import { isAgentId } from './agents';
import {
  AgentId,
  ChainLink,
  MAX_CHAIN_DELAY_MINUTES,
  PermissionMode,
  Recurrence,
  TaskSeries
} from './types';

/**
 * What the manager is allowed to change about a scheduled series.
 *
 * The webview is our own code behind a nonce-locked CSP, so this is not defence
 * against a hostile sender — it is defence against a typed interface being
 * mistaken for a checked one. `Partial<TaskSeries>` is erased at runtime, and
 * three of these fields leave the process: `model` becomes an argv entry for a
 * shell-invoked spawn on Windows, `agent` chooses which executable that spawn
 * runs, and `filePath` decides which file the agent is handed as its prompt.
 * None should be settable by a message — `agent` is checked against a closed
 * list, so it can only ever name an engine this build already knows about.
 *
 * `command.ts` does the same job for the phone, with a narrower list. This is
 * the desktop's, and the two are deliberately separate: the manager may change
 * *what* a task does, and a remote caller may not.
 *
 * Pure — no `vscode` — so every rule below is a unit test.
 */

const PERMISSION_MODES: readonly PermissionMode[] = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'dontAsk',
  'manual',
  'plan'
];

/**
 * Model ids are matched by shape rather than against a list, so pinning a model
 * released after this build still works. The shape is the part that matters:
 * `runner.ts` spawns through a shell on Windows, where Node does not quote
 * arguments, so anything a shell would read as syntax must not survive.
 *
 * `/` and `:` are allowed because every opencode model id needs both —
 * `opencode/north-mini-code-free`, `ollama/gemma4:26b`. Neither is shell syntax
 * in argument position, so the guarantee above is unchanged.
 */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Identity and provenance. Changing any of these makes it a different task. */
const NEVER_EDITABLE = ['id', 'filePath', 'fileName', 'createdAt'];

export interface SeriesEdit {
  patch: Partial<TaskSeries>;
  /** Keys dropped, for the log. An empty list means the message was entirely valid. */
  rejected: string[];
}

export function seriesEdit(raw: unknown): SeriesEdit {
  const patch: Partial<TaskSeries> = {};
  const rejected: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return { patch, rejected: ['(not an object)'] };
  }

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (NEVER_EDITABLE.includes(key)) {
      rejected.push(key);
      continue;
    }

    switch (key) {
      case 'nextRunAt': {
        const instant = typeof value === 'string' ? Date.parse(value) : NaN;
        if (Number.isNaN(instant)) {
          rejected.push(key);
        } else {
          // Normalised rather than stored verbatim: the scheduler compares these
          // as instants, and the store is read by things that expect UTC.
          patch.nextRunAt = new Date(instant).toISOString();
        }
        break;
      }

      case 'recurrence': {
        if (value === null) {
          patch.recurrence = null;
        } else {
          const recurrence = validRecurrence(value);
          if (recurrence) {
            patch.recurrence = recurrence;
          } else {
            rejected.push(key);
          }
        }
        break;
      }

      case 'chain': {
        // Null clears the link — that is Unlink, and it is a real edit rather
        // than a rejection. Shape only: whether the plan it names still exists,
        // and whether the link would make a loop, are questions this module has
        // no series list to answer. `chain.ts` answers them for the caller.
        if (value === null || value === undefined) {
          patch.chain = undefined;
        } else {
          const link = validChainLink(value);
          if (link) {
            patch.chain = link;
          } else {
            rejected.push(key);
          }
        }
        break;
      }

      case 'enabled':
      case 'spent': {
        if (typeof value === 'boolean') {
          patch[key] = value;
        } else {
          rejected.push(key);
        }
        break;
      }

      case 'permissionMode': {
        if (PERMISSION_MODES.includes(value as PermissionMode)) {
          patch.permissionMode = value as PermissionMode;
        } else {
          rejected.push(key);
        }
        break;
      }

      case 'agent': {
        // Empty or absent means Claude, which is what an unset `agent` has
        // always meant — so clearing it is a valid edit rather than a rejection.
        if (value === undefined || value === null || value === '') {
          patch.agent = undefined;
        } else if (isAgentId(value)) {
          patch.agent = value as AgentId;
        } else {
          rejected.push(key);
        }
        break;
      }

      case 'model': {
        // Empty or absent means the account default, which is a real choice.
        if (value === undefined || value === null || value === '') {
          patch.model = undefined;
        } else if (typeof value === 'string' && MODEL_PATTERN.test(value)) {
          patch.model = value;
        } else {
          rejected.push(key);
        }
        break;
      }

      case 'cwd': {
        if (typeof value === 'string' && value.trim()) {
          patch.cwd = value;
        } else {
          rejected.push(key);
        }
        break;
      }

      case 'maxRetries': {
        if (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 10) {
          patch.maxRetries = value as number;
        } else {
          rejected.push(key);
        }
        break;
      }

      default:
        rejected.push(key);
    }
  }

  return { patch, rejected };
}

/**
 * A chain link, checked the same way a recurrence is: a malformed one would sit
 * in the store and be read by the arming rule on every tick. The gap is capped
 * at a day — a longer wait is a clock time, not a chain.
 */
function validChainLink(value: unknown): ChainLink | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as Partial<ChainLink>;

  if (typeof candidate.after !== 'string' || !candidate.after.trim()) {
    return undefined;
  }
  if (
    !Number.isInteger(candidate.delayMinutes) ||
    (candidate.delayMinutes as number) < 0 ||
    (candidate.delayMinutes as number) > MAX_CHAIN_DELAY_MINUTES
  ) {
    return undefined;
  }
  if (typeof candidate.stopOnFailure !== 'boolean') {
    return undefined;
  }

  return {
    after: candidate.after,
    delayMinutes: candidate.delayMinutes as number,
    stopOnFailure: candidate.stopOnFailure
  };
}

/**
 * An empty `daysOfWeek` or a malformed `timeLocal` makes `computeNextRun` throw,
 * and it throws inside the scheduler's tick — so one bad rule would stop every
 * task from running. Rejecting it at the door is cheaper than recovering from it.
 */
function validRecurrence(value: unknown): Recurrence | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as Partial<Recurrence>;

  if (typeof candidate.timeLocal !== 'string' || !TIME_PATTERN.test(candidate.timeLocal)) {
    return undefined;
  }

  // A monthly rule keeps its day in `dayOfMonth` and leaves `daysOfWeek` empty,
  // so it is checked first — the days-of-week rules below would reject it.
  if (candidate.dayOfMonth !== undefined) {
    if (
      !Number.isInteger(candidate.dayOfMonth) ||
      candidate.dayOfMonth < 1 ||
      candidate.dayOfMonth > 31
    ) {
      return undefined;
    }
    return { daysOfWeek: [], timeLocal: candidate.timeLocal, dayOfMonth: candidate.dayOfMonth };
  }

  if (!Array.isArray(candidate.daysOfWeek) || candidate.daysOfWeek.length === 0) {
    return undefined;
  }

  const days = new Set<number>();
  for (const day of candidate.daysOfWeek) {
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      return undefined;
    }
    days.add(day);
  }

  return { daysOfWeek: [...days].sort((a, b) => a - b), timeLocal: candidate.timeLocal };
}

import * as path from 'path';
import { seriesEdit } from './edit';
import type { Answer, AskedQuestion, QuestionFile } from './questions';
import { computeNextRun } from './recurrence';
import { DAILY, LOCK_STALE_MS, Recurrence, TaskSeries } from './types';

/**
 * What an MCP client is allowed to ask Chronos to do.
 *
 * This module *is* the security boundary for the agent channel, the way
 * `command.ts` is for the phone — but drawn in a different place, because the
 * two callers are trusted with different things. A phone may only change *when*
 * a task runs. An agent may write the plan too, because authoring is the whole
 * point of connecting one; what it may not do is set `permissionMode`.
 *
 * That single refusal is the load-bearing rule. Chronos runs coding agents
 * unattended, on a schedule, in a real repository. An agent that could set its
 * own task to `bypassPermissions` would be granting itself recurring,
 * unrestricted tool access on this machine without a human ever seeing the
 * decision — so raising a task above the `auto` default stays a click in the
 * manager, made by a person looking at the plan.
 *
 * Pure — no `vscode`, no `fs`, no process — so every rejection below is a unit
 * test rather than something we hope is right. `mcp-server.ts` does the reading
 * and writing and applies the verdicts; this decides. `path` is the one import
 * that touches the filesystem's vocabulary, and it is arithmetic on strings
 * rather than access: `planCwd` has to compare two paths, and nothing else here
 * can answer that question.
 */

///////////////////////////*What comes off the wire*////////////////////////////

/** Repeat rules an agent may ask for, matching `setRepeat` in `command.ts`. */
export type RepeatKind = 'once' | 'daily' | 'weekly' | 'monthly';

/** `schedule_plan`'s timing arguments. Every field is untrusted. */
export interface ScheduleWhen {
  /** An ISO 8601 instant. Used alone for a one-shot, or with `repeat`. */
  at?: unknown;
  /** "HH:MM" local wall-clock time, for a repeating rule. */
  timeLocal?: unknown;
  repeat?: unknown;
  /** 0 = Sunday .. 6 = Saturday. Only read by a weekly rule. */
  daysOfWeek?: unknown;
  /** 1–31. Only read by a monthly rule; defaults to the day `at` falls on. */
  dayOfMonth?: unknown;
}

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string };

/** When a series should first run, and whether it comes back. */
export interface Timing {
  /** ISO 8601 UTC. */
  nextRunAt: string;
  /** null = one-shot. */
  recurrence: Recurrence | null;
}

/**
 * A schedule target this far in the past is a mistake rather than an
 * instruction — the same tolerance, and the same reasoning, as `command.ts`.
 * Anything nearer is let through to fire on the next tick.
 */
const PAST_TOLERANCE_MS = 5 * 60_000;

/**
 * The refusal an agent reads when it tries to set its own permissions. Worded
 * as a fact about where the setting lives, not as an error, because the agent
 * will show it to the user and the next step is a human opening the manager.
 */
export const PERMISSION_REFUSAL =
  'permissionMode cannot be set over MCP. A new task runs in `auto` mode; ' +
  'raising it is a decision a person makes in the Chronos manager, on a plan ' +
  'they have read.';

///////////////////////////*Timing*////////////////////////////

/**
 * Turns the friendly `when` arguments into a concrete first run plus a rule.
 *
 * `computeNextRun` derives the instant from the rule rather than the caller
 * supplying both, so a recurring series' first occurrence is the same instant
 * its second one will be — an agent that sent a `timeLocal` of 02:00 and an
 * `at` of 02:07 would otherwise get a series that fires at 02:07 once and 02:00
 * forever after.
 */
export function planTiming(when: ScheduleWhen, now: Date = new Date()): Verdict<Timing> {
  const repeat = when.repeat ?? 'once';
  if (!isRepeatKind(repeat)) {
    return refuse('repeat must be once, daily, weekly or monthly.');
  }

  if (repeat === 'once') {
    const at = parseInstant(when.at);
    if (at === undefined) {
      return refuse('A one-off schedule needs `at` as an ISO 8601 date and time.');
    }
    if (now.getTime() - at > PAST_TOLERANCE_MS) {
      return refuse('That time has already passed.');
    }
    return { ok: true, value: { nextRunAt: new Date(at).toISOString(), recurrence: null } };
  }

  const timeLocal = repeatTime(when);
  if (!timeLocal) {
    return refuse('A repeating schedule needs `timeLocal` as "HH:MM", or an `at` to take it from.');
  }

  const recurrence = repeatRule(repeat, timeLocal, when, now);
  if (!recurrence.ok) {
    return recurrence;
  }

  // Through `seriesEdit`'s own recurrence check before it is used, so a rule
  // that would make the scheduler tick throw cannot be written by this path
  // either — one validator, not two spellings of one.
  const checked = seriesEdit({ recurrence: recurrence.value });
  if (checked.rejected.length || !checked.patch.recurrence) {
    return refuse('That repeat rule is not a valid recurrence.');
  }

  return {
    ok: true,
    value: {
      nextRunAt: computeNextRun(checked.patch.recurrence, now).toISOString(),
      recurrence: checked.patch.recurrence
    }
  };
}

/** An explicit `timeLocal` wins; otherwise the wall clock of `at`, if given. */
function repeatTime(when: ScheduleWhen): string | undefined {
  if (typeof when.timeLocal === 'string') {
    return TIME_PATTERN.test(when.timeLocal) ? when.timeLocal : undefined;
  }
  const at = parseInstant(when.at);
  // No `at` either is not an error to report from here — `planTiming` says what
  // is missing. A past `at` is fine for a repeating rule: only its clock is read.
  return at === undefined ? undefined : localTimeOf(at);
}

function repeatRule(
  repeat: Exclude<RepeatKind, 'once'>,
  timeLocal: string,
  when: ScheduleWhen,
  now: Date
): Verdict<Recurrence> {
  if (repeat === 'daily') {
    return { ok: true, value: { daysOfWeek: DAILY, timeLocal } };
  }

  if (repeat === 'weekly') {
    const days = parseDays(when.daysOfWeek);
    if (!days) {
      return refuse('A weekly rule needs `daysOfWeek`: whole numbers 0 (Sunday) to 6 (Saturday).');
    }
    return { ok: true, value: { daysOfWeek: days, timeLocal } };
  }

  // Monthly. An unstated day is the one the start date falls on, which is what
  // "monthly from this date" means and saves the agent a second argument.
  const dayOfMonth =
    when.dayOfMonth === undefined
      ? new Date(parseInstant(when.at) ?? now.getTime()).getDate()
      : when.dayOfMonth;

  if (!Number.isInteger(dayOfMonth) || (dayOfMonth as number) < 1 || (dayOfMonth as number) > 31) {
    return refuse('`dayOfMonth` must be a whole number from 1 to 31.');
  }
  return { ok: true, value: { daysOfWeek: [], timeLocal, dayOfMonth: dayOfMonth as number } };
}

///////////////////////////*Editing an existing series*////////////////////////////

/**
 * Validates an `update_schedule` patch against a series that exists.
 *
 * Every field is checked by `seriesEdit` — the manager's own validator, which
 * already closes `agent` to a known list, shape-checks `model` against what a
 * Windows shell would read as syntax, normalises `nextRunAt` and refuses
 * identity fields outright. The MCP rules are the two things it does not know:
 * `permissionMode` is refused rather than accepted, and a `nextRunAt` in the
 * past is refused rather than written.
 *
 * A rejected field fails the whole call instead of being quietly dropped. The
 * manager can drop one, because a human is looking at the control that did not
 * move; an agent is told, so it can say what it could not do.
 */
export function planSeriesUpdate(
  raw: unknown,
  series: TaskSeries | undefined,
  now: Date = new Date()
): Verdict<Partial<TaskSeries>> {
  if (!series) {
    return refuse('No scheduled task has that id. Call list_schedule for the current ids.');
  }
  if (raw && typeof raw === 'object' && 'permissionMode' in (raw as object)) {
    return refuse(PERMISSION_REFUSAL);
  }

  const { patch, rejected } = seriesEdit(raw);
  if (rejected.length) {
    return refuse(`Cannot set: ${rejected.join(', ')}.`);
  }
  if (!Object.keys(patch).length) {
    return refuse('Nothing to change.');
  }

  if (patch.nextRunAt !== undefined) {
    const target = Date.parse(patch.nextRunAt);
    if (now.getTime() - target > PAST_TOLERANCE_MS) {
      return refuse('That time has already passed.');
    }
  }

  return { ok: true, value: patch };
}

/**
 * The half of `schedule_plan` that is not timing: the overrides a new series is
 * born with. Run through `seriesEdit` for the same reason as above — `agent`,
 * `model`, `cwd` and `maxRetries` all leave the process when the run fires.
 */
export function planSeriesOverrides(raw: unknown): Verdict<Partial<TaskSeries>> {
  if (raw && typeof raw === 'object' && 'permissionMode' in (raw as object)) {
    return refuse(PERMISSION_REFUSAL);
  }

  const { patch, rejected } = seriesEdit(raw ?? {});
  if (rejected.length) {
    return refuse(`Cannot set: ${rejected.join(', ')}.`);
  }
  return { ok: true, value: patch };
}

///////////////////////////*Where a run may be pointed*////////////////////////////

/**
 * Contains the working directory a scheduled run is given.
 *
 * `library.planPath` contains *which file* a run is handed, and that rule is
 * already load-bearing. This is the other half: the directory it is handed that
 * file *in*, which is what actually decides how far the run can reach. A new
 * task runs in `auto` mode — it edits without stopping to ask, with nobody
 * watching — so an unchecked `cwd` hands an agent that can already write a plan
 * an unattended coding agent pointed at any folder on the disk. That is the same
 * grant `permissionMode` is refused for, arrived at from the other side, and it
 * has to be refused the same way.
 *
 * The project folder itself is the default and is allowed; so is anything under
 * it, because a package inside a monorepo is a real reason to want a
 * sub-directory. Anything outside is not a folder this server speaks for.
 *
 * A relative path is resolved against the project folder rather than refused —
 * `packages/api` is the obvious way to ask for the case above, and resolving it
 * here means the stored `cwd` is always absolute, which is what `runner.ts`
 * spawns with.
 */
export function planCwd(raw: unknown, folder: string): Verdict<string> {
  if (typeof raw !== 'string' || !raw.trim()) {
    return refuse('`cwd` must be a path inside this project.');
  }

  const root = path.resolve(folder);
  const target = path.resolve(root, raw);
  const rel = path.relative(root, target);

  // '' is the project folder itself. A leading '..' or an absolute answer both
  // mean the target sits outside it — the second happens on Windows when the
  // two paths are on different drives, where there is no relative form at all.
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
    return refuse(
      `\`cwd\` must be inside ${root}. This server speaks for one project, and a run ` +
        'cannot be aimed at another folder from here.'
    );
  }

  return { ok: true, value: target };
}

///////////////////////////*Is anything there to run it*////////////////////////////

/**
 * Whether a VS Code window is currently scheduling this folder.
 *
 * A missing lock and a lock nobody has renewed mean the same thing: the writes
 * an agent makes will sit on disk until a window opens. Taking the holder as an
 * argument rather than a path keeps the rule testable and leaves the file read
 * in `mcp-server.ts`, the same split the rest of this module uses.
 */
export function schedulerIsLive(
  held: { heartbeatAt: number } | undefined,
  now: number = Date.now(),
  staleMs: number = LOCK_STALE_MS
): boolean {
  return Boolean(held) && now - held!.heartbeatAt <= staleMs;
}

/**
 * What an agent is told when it schedules something with no window watching.
 * Worded as a fact about what happens next rather than as a warning: the
 * schedule really was saved, and the agent needs to pass that on accurately.
 */
export const QUEUED_NOTE =
  'No VS Code window is open on this project at the moment, so nothing will ' +
  'run until one is. The schedule is saved and will fire when a window opens.';

///////////////////////////*Asking and answering*////////////////////////////

/**
 * The ceilings on one question. Generous enough that a real clarifying question
 * fits comfortably, low enough that a confused session cannot fill the folder
 * with a megabyte of prose nobody will read on a phone.
 */
const MAX_SUMMARY = 2000;
const MAX_QUESTIONS = 10;
const MAX_QUESTION = 1000;
const MAX_OPTIONS = 6;
const MAX_OPTION = 200;
const MAX_ANSWER = 4000;

/** What `ask_user` is allowed to post, with the question ids assigned. */
export interface PlannedQuestion {
  summary: string;
  questions: AskedQuestion[];
}

/**
 * Checks a question a planning session wants to put in front of the user.
 *
 * The ids are assigned here rather than taken from the caller, which is what
 * makes `planAnswers` below able to say "you have not answered q2": two
 * questions sharing an id, or an id that collides with nothing, would turn
 * answering into guesswork at the far end — where there is a phone and no way
 * to go back and look.
 *
 * Nothing here loosens the rule the rest of this file exists for. An answer is
 * text that steers a plan; the plan still has to be scheduled deliberately, by
 * a person, before anything runs.
 */
export function planQuestion(raw: unknown): Verdict<PlannedQuestion> {
  if (!raw || typeof raw !== 'object') {
    return refuse('A question needs a summary and at least one question.');
  }
  const input = raw as { summary?: unknown; questions?: unknown };

  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (!summary) {
    return refuse('`summary` is required: one or two sentences on what this is about.');
  }
  if (summary.length > MAX_SUMMARY) {
    return refuse(`\`summary\` must be ${MAX_SUMMARY} characters or fewer.`);
  }

  if (!Array.isArray(input.questions) || input.questions.length === 0) {
    return refuse('`questions` must hold at least one question.');
  }
  if (input.questions.length > MAX_QUESTIONS) {
    return refuse(`Ask at most ${MAX_QUESTIONS} questions at a time.`);
  }

  const questions: AskedQuestion[] = [];
  for (const [index, entry] of input.questions.entries()) {
    const asked = (entry ?? {}) as { question?: unknown; options?: unknown };

    const question = typeof asked.question === 'string' ? asked.question.trim() : '';
    if (!question) {
      return refuse(`Question ${index + 1} has no \`question\` text.`);
    }
    if (question.length > MAX_QUESTION) {
      return refuse(`Question ${index + 1} must be ${MAX_QUESTION} characters or fewer.`);
    }

    const options = planOptions(asked.options, index + 1);
    if (!options.ok) {
      return options;
    }

    questions.push({
      id: `q${index + 1}`,
      question,
      ...(options.value.length ? { options: options.value } : {})
    });
  }

  return { ok: true, value: { summary, questions } };
}

/** An empty list and an absent one mean the same thing: a free-text question. */
function planOptions(raw: unknown, position: number): Verdict<string[]> {
  if (raw === undefined || raw === null) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(raw)) {
    return refuse(`Question ${position}: \`options\` must be a list of strings.`);
  }
  if (raw.length > MAX_OPTIONS) {
    return refuse(`Question ${position}: at most ${MAX_OPTIONS} options.`);
  }

  const options: string[] = [];
  for (const entry of raw) {
    const option = typeof entry === 'string' ? entry.trim() : '';
    if (!option) {
      return refuse(`Question ${position}: an option cannot be empty.`);
    }
    if (option.length > MAX_OPTION) {
      return refuse(`Question ${position}: an option must be ${MAX_OPTION} characters or fewer.`);
    }
    options.push(option);
  }

  return { ok: true, value: options };
}

/**
 * Checks a set of answers against the question that was actually asked.
 *
 * Every question must be answered and no answer may name a question that was
 * not asked. Partial answers are refused rather than recorded because a
 * question can only be answered once — recording half of them would strand the
 * waiting session on the half it still needs, with no way to ask again.
 *
 * A refusal names what is missing or unrecognised, since the caller is another
 * agent and this is the only thing it has to go on.
 */
export function planAnswers(file: QuestionFile, raw: unknown): Verdict<Answer[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return refuse('`answers` must hold one answer for each question that was asked.');
  }

  const asked = new Set(file.questions.map((question) => question.id));
  const answers = new Map<string, string>();

  for (const entry of raw) {
    const given = (entry ?? {}) as { id?: unknown; answer?: unknown };

    if (typeof given.id !== 'string' || !asked.has(given.id)) {
      return refuse(
        `No question called "${String(given.id)}" was asked. This question asks: ` +
          `${[...asked].join(', ')}.`
      );
    }
    if (answers.has(given.id)) {
      return refuse(`${given.id} was answered twice in the same call.`);
    }

    const answer = typeof given.answer === 'string' ? given.answer.trim() : '';
    if (!answer) {
      return refuse(`${given.id} needs an answer.`);
    }
    if (answer.length > MAX_ANSWER) {
      return refuse(`The answer to ${given.id} must be ${MAX_ANSWER} characters or fewer.`);
    }

    answers.set(given.id, answer);
  }

  const missing = [...asked].filter((id) => !answers.has(id));
  if (missing.length) {
    return refuse(`Still unanswered: ${missing.join(', ')}. Answer every question in one call.`);
  }

  // In the order they were asked, so the session reads them alongside its own
  // questions rather than in whatever order the answering agent happened to use.
  return { ok: true, value: file.questions.map((q) => ({ id: q.id, answer: answers.get(q.id)! })) };
}

///////////////////////////*Helpers*////////////////////////////

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const REPEAT_KINDS: readonly RepeatKind[] = ['once', 'daily', 'weekly', 'monthly'];

function isRepeatKind(value: unknown): value is RepeatKind {
  return REPEAT_KINDS.includes(value as RepeatKind);
}

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

function parseInstant(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Sorted and deduplicated, or undefined if anything in the list is not a day. */
function parseDays(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const days = new Set<number>();
  for (const entry of value) {
    if (!Number.isInteger(entry) || (entry as number) < 0 || (entry as number) > 6) {
      return undefined;
    }
    days.add(entry as number);
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * The wall clock of an instant, in the timezone of the machine that will run the
 * job — which is this one, since the agent spawns the server on the machine its
 * project lives on. A recurrence stores wall-clock time, not an instant, so this
 * is the conversion that makes "every night at 2am" survive a DST boundary.
 */
function localTimeOf(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

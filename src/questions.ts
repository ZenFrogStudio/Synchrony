import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Questions a planning session asks, and the answers that come back.
 *
 * A planning session runs in a VS Code terminal, and everything it wants to know
 * it has always asked *there* — which means somebody has to be sitting at that
 * terminal for a plan to get written. This is the other channel: the session
 * writes its question here as a file, and anything with access to the same
 * `.synchrony` tree can answer it. In practice that is Claude Desktop, driven from
 * a phone, on this same machine.
 *
 * Files rather than a port or a socket, for the same reason the schedule is a
 * file: the two ends are separate processes that never meet, there is nothing to
 * start or keep alive, and an unanswered question is visible in a directory
 * listing. Nothing leaves the machine.
 *
 * This module owns the on-disk shape and nothing else. What a question is
 * *allowed* to contain is decided in `mcp-tools.ts`, keeping the same split that
 * file's header already describes — the rules are pure and unit-tested, and the
 * reading and writing lives out here.
 *
 * No `vscode` import, same rule as `library.ts` and `roots.ts`: the MCP server
 * is a plain Node process and has to be able to load it.
 */

///////////////////////////*The shape on disk*////////////////////////////

/** One question, with an id the answer has to name. */
export interface AskedQuestion {
  /** `q1`, `q2` … assigned by `mcp-tools.planQuestion`, never by the caller. */
  id: string;
  question: string;
  /** Suggested replies, when the session has a shortlist in mind. */
  options?: string[];
}

export interface Answer {
  /** The `id` of the question this answers. */
  id: string;
  answer: string;
}

export interface QuestionFile {
  /** 12 hex characters. Also the file name, minus `.json`. */
  id: string;
  /** ISO 8601 UTC. */
  askedAt: string;
  /** What the session was working on — the task it came from. */
  source?: string;
  summary: string;
  questions: AskedQuestion[];
  /** Present only once answered; its absence is what `ask_user` waits on. */
  answeredAt?: string;
  answers?: Answer[];
}

/** The outcome of `recordAnswers`, in the `Verdict` shape `mcp-tools.ts` uses. */
export type RecordOutcome =
  | { ok: true; value: QuestionFile }
  | { ok: false; reason: string };

const EXTENSION = '.json';

/** A week. Long enough that a question asked on a Friday survives the weekend. */
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * Names this process's temp files apart from every other writer's.
 *
 * The reasoning is `state-file.ts`'s, and so is the once-per-process scope: two
 * MCP servers can be running against one folder — the planning session's own,
 * and whichever one Claude Desktop spawned — and a shared temp name would let
 * their writes interleave into a file that parses as nothing.
 */
const WRITER = randomBytes(4).toString('hex');

///////////////////////////*Addressing a question*////////////////////////////

export function newQuestionId(): string {
  return randomBytes(6).toString('hex');
}

const ID_PATTERN = /^[0-9a-f]{12}$/;

/**
 * Resolves an id to its file, refusing anything that is not one.
 *
 * The same guard `library.planPath` puts on a plan name, and here for the same
 * reason: an id arrives off the wire from an agent, and a name that reached the
 * filesystem unchecked could address any file on this disk. The pattern is the
 * whole check — a 12-character hex string cannot contain a separator, a `..` or
 * an extension, so there is nothing left to strip.
 */
export function questionPath(dir: string, id: string): string {
  if (!ID_PATTERN.test(id)) {
    throw new Error(`Not a question id: ${id}`);
  }
  return path.join(dir, `${id}${EXTENSION}`);
}

///////////////////////////*Reading and writing*////////////////////////////

/**
 * Writes through a temp file and a rename, so a reader polling this directory
 * once a second never catches a half-written question. `writeState` explains the
 * rest of the reasoning; this is the same pattern against a smaller file.
 */
export function writeQuestion(dir: string, file: QuestionFile): QuestionFile {
  fs.mkdirSync(dir, { recursive: true });
  const target = questionPath(dir, file.id);
  const temp = `${target}.${WRITER}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(file, null, 2), 'utf8');
  fs.renameSync(temp, target);
  return file;
}

/**
 * The question, or undefined if it is missing, unreadable or not a question.
 *
 * An id that is not an id lands here too, and gets the same answer rather than
 * a thrown error. Nothing is opened either way — `questionPath` refuses first —
 * and every caller already turns undefined into "there is no question with that
 * id", which is both true and the sentence an agent can act on.
 */
export function readQuestion(dir: string, id: string): QuestionFile | undefined {
  if (!ID_PATTERN.test(id)) {
    return undefined;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(questionPath(dir, id), 'utf8');
  } catch {
    return undefined;
  }
  return parse(raw);
}

/**
 * Every question in the folder, newest first. Unreadable or unparseable entries
 * are skipped rather than failing the list, like `library.listPlans` — one file
 * a text editor was halfway through saving must not hide every other question
 * from the person trying to answer them.
 */
export function listQuestions(dir: string): QuestionFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // A folder no session has ever asked from has no `questions`.
  }

  const found: QuestionFile[] = [];
  for (const name of names) {
    if (path.extname(name).toLowerCase() !== EXTENSION) {
      continue;
    }
    try {
      const file = parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      // The id in the file has to be the id in its name, or answering what
      // `list_questions` reported would write to a different file.
      if (file && `${file.id}${EXTENSION}` === name) {
        found.push(file);
      }
    } catch {
      // A file removed mid-listing is not worth failing the whole list for.
    }
  }

  return found.sort((a, b) => Date.parse(b.askedAt) - Date.parse(a.askedAt));
}

/**
 * Records the answers to one question, once.
 *
 * Re-read rather than written from a caller's copy, for `updateState`'s reason:
 * the answering agent and the waiting session are separate processes, and the
 * file may have been answered between the two calls. That re-read is also what
 * makes "already answered" a refusal rather than a silent overwrite — the
 * session may already have acted on the first set of answers, and a second set
 * quietly replacing them would steer a plan nobody could account for.
 */
export function recordAnswers(dir: string, id: string, answers: Answer[]): RecordOutcome {
  const file = readQuestion(dir, id);
  if (!file) {
    return { ok: false, reason: `There is no open question with the id ${id}.` };
  }
  if (file.answeredAt) {
    return { ok: false, reason: `That question was already answered at ${file.answeredAt}.` };
  }

  return {
    ok: true,
    value: writeQuestion(dir, {
      ...file,
      answeredAt: new Date().toISOString(),
      answers
    })
  };
}

///////////////////////////*Tidying up*////////////////////////////

/**
 * Deletes questions past the cutoff, answered or not.
 *
 * Answered ones have done their job. Unanswered ones are the residue of a
 * session whose terminal was closed mid-question, and nothing will ever come
 * back for them — the session that was waiting is gone. Best-effort throughout,
 * in the manner of `sweepPending`: a folder that has never been asked from
 * reports nothing, and one unreadable file does not abort the rest.
 *
 * Returns how many were removed, for the caller to log.
 */
export function sweepQuestions(dir: string, maxAgeMs = DEFAULT_MAX_AGE_MS): number {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;

  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }

  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.mtimeMs >= cutoff) {
        continue;
      }
      fs.rmSync(file, { force: true });
      removed++;
    } catch {
      // An unreadable file is not worth abandoning the rest of the sweep for.
    }
  }

  return removed;
}

///////////////////////////*Helpers*////////////////////////////

/**
 * Parses a question file, returning undefined for anything that is not one.
 *
 * These files are hand-editable by design — they sit in `questions/` rather than
 * a dot-folder precisely so they can be looked at when a session goes wrong — so
 * the shape is checked rather than trusted on the way back in.
 */
function parse(raw: string): QuestionFile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const file = value as Partial<QuestionFile>;
  if (
    typeof file.id !== 'string' ||
    !ID_PATTERN.test(file.id) ||
    typeof file.askedAt !== 'string' ||
    typeof file.summary !== 'string' ||
    !Array.isArray(file.questions) ||
    !file.questions.every(isAskedQuestion)
  ) {
    return undefined;
  }

  return file as QuestionFile;
}

function isAskedQuestion(value: unknown): value is AskedQuestion {
  const asked = value as Partial<AskedQuestion>;
  return (
    Boolean(asked) &&
    typeof asked.id === 'string' &&
    typeof asked.question === 'string' &&
    (asked.options === undefined ||
      (Array.isArray(asked.options) && asked.options.every((o) => typeof o === 'string')))
  );
}

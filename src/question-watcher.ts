import * as fs from 'fs';
import * as vscode from 'vscode';
import { log } from './log';
import { Answer, AskedQuestion, listQuestions, QuestionFile, readQuestion, recordAnswers } from './questions';
import { SynchronyPaths } from './roots';

/**
 * Watches a folder's `questions/` and offers each open question in the editor.
 *
 * A planning session opened from the phone (through `requests/`) asks
 * everything through `ask_user`, which writes the question to this directory
 * for the phone to answer. That routing is untouched here. The trouble is that
 * the phone is not always where the user is: `RequestWatcher` sweeps at
 * startup, so a request left over from earlier can start a session that asks
 * the phone questions while the user is sitting at the keyboard, with nothing
 * in the editor to say a question is waiting. This is the same file offered at
 * the other end of the channel too. Whichever end answers first wins —
 * `recordAnswers` re-reads and refuses a second answer — so the phone keeps
 * working and the editor gets a way in.
 *
 * Deliberately no leader/follower election, unlike `RequestWatcher` and
 * `ControlWatcher`. Those claim by rename so exactly one window acts; a
 * question has no claim step — the file has to stay in place, unmodified, for
 * the session's `waitForAnswers` poll to find — so every window on the folder
 * notifies, and the first-writer-wins re-read inside `recordAnswers` settles
 * the race. The losing window just sees "already answered".
 *
 * The UI is injected (`promptForAnswers` below, in the extension) rather than
 * called directly, so the watcher can be driven in plain Node with a recording
 * handler — the same split as `RequestWatcher`'s `RequestHandler`.
 */

const DEBOUNCE_MS = 200;
/**
 * A question older than this is not offered. One `ask_user` call waits at most
 * 600 s (`MAX_WAIT_SECONDS`, `mcp-server.ts`); a session that has been waiting
 * longer than that has most likely given up or been closed, and a notification
 * for it is noise the user has to dismiss. The same age gate `ControlWatcher`
 * puts on an unowned cancel, and a sweep at window start is where it matters:
 * `questions/` keeps files for a week, and none of last Tuesday's should pop up.
 */
const STALE_MS = 10 * 60_000;

export type QuestionHandler = (file: QuestionFile) => Promise<void>;

export class QuestionWatcher implements vscode.Disposable {
  private watcher: fs.FSWatcher | undefined;
  private debounce: NodeJS.Timeout | undefined;
  /**
   * Ids this window has already put a notification up for. Never re-notified:
   * a session resuming its wait with the same id reuses the same file, and a
   * second sweep firing while the QuickPick is open must not stack a duplicate.
   */
  private readonly shown = new Set<string>();

  constructor(
    private readonly paths: () => SynchronyPaths,
    private readonly handle: QuestionHandler
  ) {}

  /** Also the folder-switch cleanup: a new folder starts with nothing shown. */
  restart(): void {
    this.stop();
    this.shown.clear();
    const dir = this.paths().questions;
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.watcher = fs.watch(dir, (_event, filename) => {
        const name = filename ? String(filename) : '';
        if (!name.endsWith('.json')) {
          return; // `writeQuestion` stages through a `.tmp` first; the rename is the event.
        }
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.sweep(), DEBOUNCE_MS);
      });
    } catch (err) {
      log.warn(`could not watch planning questions: ${String(err)}`);
    }
    this.sweep();
  }

  dispose(): void {
    this.stop();
  }

  private stop(): void {
    clearTimeout(this.debounce);
    this.watcher?.close();
    this.watcher = undefined;
  }

  /**
   * Skipping an answered file is also what swallows the watch event the
   * answer write itself fires, from either end of the channel.
   */
  private sweep(): void {
    const dir = this.paths().questions;
    for (const file of listQuestions(dir)) {
      if (file.answeredAt || this.shown.has(file.id)) {
        continue;
      }
      const age = Date.now() - Date.parse(file.askedAt);
      if (!(age <= STALE_MS)) {
        continue; // Also an `askedAt` that does not parse: nothing to date it by.
      }
      // Marked before anything is awaited, so a sweep landing mid-prompt sees it.
      this.shown.add(file.id);
      void this.handle(file).catch((err) => {
        log.warn(`could not offer planning question ${file.id}: ${String(err)}`);
      });
    }
  }
}

///////////////////////////*Answering from the editor*////////////////////////////

const OTHER = 'Other (type an answer)…';
/** Enough of the first question to say what the notification is about. */
const PREVIEW_CHARS = 80;

/**
 * One notification per question file; answering walks the questions one at a
 * time. `recordAnswers` is the only write path, and its refusal covers both
 * losing the race to the phone and the file being deleted mid-flow, so nothing
 * here needs to throw. Backing out at any step leaves the file exactly as it
 * was: the phone can still answer, and this window will not ask again.
 */
export async function promptForAnswers(dir: string, file: QuestionFile): Promise<void> {
  const first = file.questions[0]?.question ?? file.summary;
  const preview = first.length > PREVIEW_CHARS ? `${first.slice(0, PREVIEW_CHARS - 1)}…` : first;
  const more = file.questions.length > 1 ? ` (+${file.questions.length - 1} more)` : '';
  const choice = await vscode.window.showInformationMessage(
    `Plan session asks: ${preview}${more}`,
    'Answer',
    'Dismiss'
  );
  if (choice !== 'Answer') {
    return; // Dismissed or closed. The phone can still answer.
  }

  // Re-read rather than trusting the copy the sweep handed over: the phone may
  // have answered while the notification sat there.
  const current = readQuestion(dir, file.id);
  if (!current || current.answeredAt) {
    void vscode.window.showInformationMessage('That question was answered from another device.');
    return;
  }

  const answers: Answer[] = [];
  for (const question of current.questions) {
    const answer = await askOne(question);
    if (answer === undefined) {
      return; // Esc. Nothing written.
    }
    answers.push({ id: question.id, answer });
  }

  const outcome = recordAnswers(dir, file.id, answers);
  if (!outcome.ok) {
    void vscode.window.showInformationMessage(outcome.reason);
  }
}

/**
 * A shortlist is a QuickPick with a way out to free text; no shortlist goes
 * straight to the box. `ignoreFocusOut` on both, because the whole point is a
 * user who is also doing something else in the editor. Blank is refused the
 * way `planAnswers` refuses it from the phone — the session has to be given
 * something it can act on.
 */
async function askOne(question: AskedQuestion): Promise<string | undefined> {
  const typed = (): Thenable<string | undefined> =>
    vscode.window
      .showInputBox({
        prompt: question.question,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : 'An answer is needed.')
      })
      .then((value) => value?.trim());

  if (!question.options?.length) {
    return typed();
  }
  const picked = await vscode.window.showQuickPick([...question.options, OTHER], {
    placeHolder: question.question,
    ignoreFocusOut: true
  });
  if (picked === undefined) {
    return undefined;
  }
  return picked === OTHER ? typed() : picked;
}

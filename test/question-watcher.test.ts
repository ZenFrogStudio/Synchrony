import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import Module from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { QuestionHandler } from '../src/question-watcher';
import { newQuestionId, QuestionFile, writeQuestion } from '../src/questions';
import { pathsFor, SynchronyPaths } from '../src/roots';

/**
 * The watcher is driven here the way the extension drives it — a real temp
 * directory, real question files, `restart()` — with a recording handler in
 * place of the notification. What is under test is *which* files reach the
 * handler and how often: an answered file, a stale one and one already shown
 * must never produce a notification, because each of those is a popup the user
 * has to dismiss for nothing.
 *
 * `question-watcher.ts` imports `vscode` for the notification and reaches it
 * again through `./log`, and there is no extension host here. Nothing below
 * calls the UI, and `log` only touches `vscode` inside `initLog`, so answering
 * `require('vscode')` with an empty object while the module loads is enough.
 * The hook is restored the moment the module is in the cache — the same
 * arrangement as `request-watcher.test.ts`.
 */
const loader = Module.prototype as unknown as { require: (this: unknown, id: string) => unknown };
const realRequire = loader.require;
loader.require = function (id) {
  return id === 'vscode' ? {} : realRequire.call(this, id);
};
const { QuestionWatcher } = require('../src/question-watcher') as typeof import('../src/question-watcher');
loader.require = realRequire;

let dir: string;
let paths: SynchronyPaths;
let watcher: InstanceType<typeof QuestionWatcher> | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synchrony-question-watcher-'));
  paths = pathsFor(dir);
});

afterEach(() => {
  watcher?.dispose();
  watcher = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A question asked just now, unless the caller says otherwise. */
function asked(overrides: Partial<QuestionFile> = {}): QuestionFile {
  return {
    id: newQuestionId(),
    askedAt: new Date().toISOString(),
    summary: 'Two things before this is written up.',
    questions: [
      { id: 'q1', question: 'Which engine?', options: ['claude', 'opencode'] },
      { id: 'q2', question: 'Anything else?' }
    ],
    ...overrides
  };
}

/** A handler that records what it was offered and answers at once. */
function recorder(): { served: QuestionFile[]; handle: QuestionHandler } {
  const served: QuestionFile[] = [];
  const handle: QuestionHandler = async (file) => {
    served.push(file);
  };
  return { served, handle };
}

/** Starts a watcher on the temp folder. Disposed by `afterEach`. */
function start(handle: QuestionHandler): void {
  watcher = new QuestionWatcher(() => paths, handle);
  watcher.restart();
}

/** Waits out the watcher's 200 ms debounce, so a sweep an event started has run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 400));
}

/** Polls until `check` holds, or gives up after two seconds. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('question watcher', () => {
  it('should_offer_a_fresh_unanswered_question_once', async () => {
    const file = writeQuestion(paths.questions, asked());
    const { served, handle } = recorder();

    start(handle);
    await until(() => served.length >= 1);

    assert.equal(served.length, 1);
    assert.deepEqual(served[0], file);
  });

  it('should_not_offer_the_same_question_twice_when_its_file_is_touched', async () => {
    const file = writeQuestion(paths.questions, asked());
    const { served, handle } = recorder();

    start(handle);
    await until(() => served.length >= 1);
    // A session resuming its wait, or an editor saving the file unchanged,
    // fires the watch again. The id is what is remembered, not the content.
    writeQuestion(paths.questions, file);
    await settle();

    assert.equal(served.length, 1);
  });

  it('should_never_offer_a_question_that_is_already_answered', async () => {
    writeQuestion(
      paths.questions,
      asked({
        answeredAt: new Date().toISOString(),
        answers: [
          { id: 'q1', answer: 'claude' },
          { id: 'q2', answer: 'No.' }
        ]
      })
    );
    const { served, handle } = recorder();

    start(handle);
    await settle();

    assert.deepEqual(served, []);
  });

  it('should_never_offer_a_question_older_than_the_session_would_wait_for', async () => {
    // Eleven minutes: past the ten the watcher allows, which is itself just
    // past the 600 s one `ask_user` call waits. The file is still on disk for
    // the phone, but a popup for a session that has given up is noise.
    writeQuestion(paths.questions, asked({ askedAt: new Date(Date.now() - 11 * 60_000).toISOString() }));
    const { served, handle } = recorder();

    start(handle);
    await settle();

    assert.deepEqual(served, []);
  });

  it('should_offer_a_question_again_after_a_restart', async () => {
    // `restart()` is what a folder switch calls. Forgetting what was shown is
    // deliberate: the set is per folder, and a window coming back to a folder
    // with a question still open should hear about it again.
    const file = writeQuestion(paths.questions, asked());
    const { served, handle } = recorder();

    start(handle);
    await until(() => served.length >= 1);
    watcher!.restart();
    await until(() => served.length >= 2);

    assert.equal(served.length, 2);
    assert.deepEqual(served[1], file);
  });

  it('should_skip_a_file_that_is_not_a_question_and_still_serve_the_rest', async () => {
    fs.mkdirSync(paths.questions, { recursive: true });
    // A hand edit halfway through saving, or something that is simply not JSON.
    fs.writeFileSync(path.join(paths.questions, 'abcdefabcdef.json'), '{ not json', 'utf8');
    const file = writeQuestion(paths.questions, asked());
    const { served, handle } = recorder();

    start(handle);
    await until(() => served.length >= 1);
    await settle();

    assert.equal(served.length, 1);
    assert.deepEqual(served[0], file);
  });
});

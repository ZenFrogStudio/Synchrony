import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  AskedQuestion,
  listQuestions,
  newQuestionId,
  questionPath,
  QuestionFile,
  readQuestion,
  recordAnswers,
  sweepQuestions,
  writeQuestion
} from '../src/questions';

/**
 * The question channel on disk.
 *
 * Two properties carry the weight here. An id arrives off the wire from an
 * agent, so `questionPath` refusing anything that is not twelve hex characters
 * is what stops a tool call addressing a file elsewhere on this disk. And a
 * question can only be answered once — the session waiting on it may already
 * have acted on the first set of answers, so a second set quietly replacing
 * them would steer a plan nobody could account for.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synchrony-questions-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const asked = (overrides: Partial<QuestionFile> = {}): QuestionFile => ({
  id: newQuestionId(),
  askedAt: new Date().toISOString(),
  source: 'Add an interval repeat option',
  summary: 'Two things I need to know before writing this up.',
  questions: [
    { id: 'q1', question: 'Should it repeat by the hour as well?' },
    { id: 'q2', question: 'Which engine?', options: ['claude', 'opencode'] }
  ],
  ...overrides
});

describe('questionPath', () => {
  it('should_place_a_question_inside_the_folder_it_was_given', () => {
    const id = 'abcdef012345';

    assert.equal(questionPath(dir, id), path.join(dir, 'abcdef012345.json'));
  });

  it('should_refuse_an_id_that_climbs_out_of_the_folder', () => {
    // The whole reason the guard is a pattern rather than a sanitiser: an id
    // comes off the wire, and a name that reached the filesystem unchecked
    // could address any file on this disk.
    assert.throws(() => questionPath(dir, '../../etc/passwd'));
    assert.throws(() => questionPath(dir, '..'));
  });

  it('should_refuse_an_empty_id', () => {
    assert.throws(() => questionPath(dir, ''));
  });

  it('should_refuse_an_id_that_is_not_twelve_hex_characters', () => {
    for (const id of ['abc', 'ABCDEF012345', 'abcdef01234', 'abcdef0123456', 'abcdefghijkl']) {
      assert.throws(() => questionPath(dir, id), `${id} should not be an id`);
    }
  });

  it('should_accept_every_id_it_generates', () => {
    for (let n = 0; n < 50; n++) {
      const id = newQuestionId();

      assert.doesNotThrow(() => questionPath(dir, id), `${id} was refused`);
    }
  });
});

describe('writeQuestion and readQuestion', () => {
  it('should_round_trip_a_question_intact', () => {
    const file = asked();

    writeQuestion(dir, file);

    assert.deepEqual(readQuestion(dir, file.id), file);
  });

  it('should_create_the_folder_it_writes_into', () => {
    // The tree is made on first write, not at start-up, so an agent that merely
    // listed an unconfigured project has not littered it.
    const fresh = path.join(dir, 'not-yet');
    const file = asked();

    writeQuestion(fresh, file);

    assert.ok(readQuestion(fresh, file.id));
  });

  it('should_leave_no_temp_file_behind', () => {
    // The write is a temp file plus a rename, so a reader polling once a second
    // never catches a half-written question.
    const file = asked();

    writeQuestion(dir, file);

    assert.deepEqual(fs.readdirSync(dir), [`${file.id}.json`]);
  });

  it('should_report_a_question_that_was_never_asked_as_missing', () => {
    assert.equal(readQuestion(dir, newQuestionId()), undefined);
  });

  it('should_read_nothing_through_an_id_that_is_not_one', () => {
    // The traversal is refused by `questionPath` before anything is opened; the
    // caller sees the same "no such question" it would see for any other id,
    // which is what it can actually say back to the agent that asked.
    const planted = path.join(dir, 'secrets');
    fs.writeFileSync(planted, 'not for you', 'utf8');

    for (const id of ['../../secrets', 'secrets', '..', '']) {
      assert.equal(readQuestion(dir, id), undefined, id);
    }
    assert.equal(fs.readFileSync(planted, 'utf8'), 'not for you');
  });

  it('should_treat_an_unparseable_file_as_missing', () => {
    // These files sit in a visible folder precisely so they can be looked at by
    // hand, which means a half-saved edit is a real state to survive.
    const id = newQuestionId();
    fs.writeFileSync(path.join(dir, `${id}.json`), '{ "id": ', 'utf8');

    assert.equal(readQuestion(dir, id), undefined);
  });

  it('should_treat_a_file_of_the_wrong_shape_as_missing', () => {
    const id = newQuestionId();
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, hello: true }), 'utf8');

    assert.equal(readQuestion(dir, id), undefined);
  });
});

describe('listQuestions', () => {
  it('should_return_every_question_newest_first', () => {
    const older = asked({ askedAt: '2026-08-01T09:00:00.000Z', summary: 'older' });
    const newer = asked({ askedAt: '2026-08-13T09:00:00.000Z', summary: 'newer' });
    writeQuestion(dir, older);
    writeQuestion(dir, newer);

    assert.deepEqual(listQuestions(dir).map((f) => f.summary), ['newer', 'older']);
  });

  it('should_skip_an_unparseable_file_rather_than_failing_the_list', () => {
    // One file a text editor was halfway through saving must not hide every
    // other question from the person trying to answer them.
    const good = asked();
    writeQuestion(dir, good);
    fs.writeFileSync(path.join(dir, `${newQuestionId()}.json`), 'not json', 'utf8');

    assert.deepEqual(listQuestions(dir).map((f) => f.id), [good.id]);
  });

  it('should_skip_a_file_whose_name_disagrees_with_the_id_inside_it', () => {
    // Answering what the list reported would otherwise write to a different file.
    const file = asked();
    fs.writeFileSync(path.join(dir, `${newQuestionId()}.json`), JSON.stringify(file), 'utf8');

    assert.deepEqual(listQuestions(dir), []);
  });

  it('should_ignore_anything_that_is_not_a_question_file', () => {
    writeQuestion(dir, asked());
    fs.writeFileSync(path.join(dir, 'notes.md'), 'a note to self', 'utf8');

    assert.equal(listQuestions(dir).length, 1);
  });

  it('should_report_nothing_for_a_folder_that_was_never_asked_from', () => {
    assert.deepEqual(listQuestions(path.join(dir, 'never')), []);
  });
});

describe('recordAnswers', () => {
  const answers = [
    { id: 'q1', answer: 'Yes, hourly too.' },
    { id: 'q2', answer: 'claude' }
  ];

  it('should_stamp_the_answers_and_the_time_they_arrived', () => {
    const file = asked();
    writeQuestion(dir, file);

    const outcome = recordAnswers(dir, file.id, answers);

    assert.ok(outcome.ok, 'expected the answers to be recorded');
    assert.deepEqual(outcome.value.answers, answers);
    assert.ok(outcome.value.answeredAt, 'answeredAt is what the waiting session watches for');
    assert.deepEqual(readQuestion(dir, file.id), outcome.value);
  });

  it('should_leave_the_question_itself_untouched', () => {
    const file = asked();
    writeQuestion(dir, file);

    recordAnswers(dir, file.id, answers);

    const after = readQuestion(dir, file.id) as QuestionFile;
    assert.equal(after.summary, file.summary);
    assert.deepEqual(after.questions, file.questions);
    assert.equal(after.source, file.source);
  });

  it('should_refuse_to_answer_the_same_question_twice', () => {
    // The session may already have acted on the first set. A second set quietly
    // replacing them would steer a plan nobody could account for.
    const file = asked();
    writeQuestion(dir, file);
    recordAnswers(dir, file.id, answers);

    const second = recordAnswers(dir, file.id, [
      { id: 'q1', answer: 'Actually no.' },
      { id: 'q2', answer: 'opencode' }
    ]);

    assert.ok(!second.ok, 'expected a refusal');
    assert.match(second.reason, /already answered/);
    assert.deepEqual((readQuestion(dir, file.id) as QuestionFile).answers, answers);
  });

  it('should_refuse_an_id_no_question_was_asked_under', () => {
    const outcome = recordAnswers(dir, newQuestionId(), answers);

    assert.ok(!outcome.ok, 'expected a refusal');
    assert.match(outcome.reason, /no open question/);
  });
});

describe('sweepQuestions', () => {
  const DAY_MS = 24 * 60 * 60_000;

  /** A question file, aged by hand — the sweep decides on the file's mtime. */
  function age(id: string, ageMs: number): string {
    const file = path.join(dir, `${id}.json`);
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
    return file;
  }

  it('should_delete_a_question_past_the_cutoff', () => {
    const file = asked();
    writeQuestion(dir, file);
    const onDisk = age(file.id, 8 * DAY_MS);

    assert.equal(sweepQuestions(dir), 1);
    assert.equal(fs.existsSync(onDisk), false);
  });

  it('should_delete_an_unanswered_question_too', () => {
    // The residue of a session whose terminal was closed mid-question. Nothing
    // will come back for it: the session that was waiting is gone.
    const file = asked();
    writeQuestion(dir, file);
    age(file.id, 30 * DAY_MS);

    assert.equal(sweepQuestions(dir), 1);
    assert.deepEqual(listQuestions(dir), []);
  });

  it('should_keep_a_question_inside_the_cutoff', () => {
    // A session may be waiting on this one right now.
    const file = asked();
    writeQuestion(dir, file);
    age(file.id, 5 * 60_000);

    assert.equal(sweepQuestions(dir), 0);
    assert.ok(readQuestion(dir, file.id));
  });

  it('should_honour_a_cutoff_it_is_given', () => {
    const file = asked();
    writeQuestion(dir, file);
    age(file.id, 2 * 60 * 60_000);

    assert.equal(sweepQuestions(dir, 60 * 60_000), 1);
  });

  it('should_report_nothing_for_a_folder_that_was_never_created', () => {
    assert.equal(sweepQuestions(path.join(dir, 'never')), 0);
  });
});

describe('newQuestionId', () => {
  it('should_never_repeat_itself', () => {
    const ids = new Set<string>();
    for (let n = 0; n < 500; n++) {
      ids.add(newQuestionId());
    }

    assert.equal(ids.size, 500);
  });
});

describe('the shape a question keeps', () => {
  it('should_carry_options_through_untouched', () => {
    // The answering agent shows these as the shortlist, so losing them turns a
    // pick-one into free text on a phone keyboard.
    const questions: AskedQuestion[] = [
      { id: 'q1', question: 'Which engine?', options: ['claude', 'opencode'] }
    ];
    const file = asked({ questions });
    writeQuestion(dir, file);

    assert.deepEqual(readQuestion(dir, file.id)?.questions, questions);
  });

  it('should_survive_a_question_with_no_source', () => {
    // `--source` is optional, so a server spawned without one still works.
    const file = asked({ source: undefined });
    writeQuestion(dir, file);

    assert.equal(readQuestion(dir, file.id)?.source, undefined);
  });
});

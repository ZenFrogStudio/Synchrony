import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  archivePlan,
  createPlan,
  duplicatePlan,
  ensureLibrary,
  firstWords,
  importFile,
  isInside,
  listPlans,
  parseUriList,
  planPath,
  readPlan,
  removePlan,
  renamePlan,
  samePath,
  seedLibrary,
  taskLabel,
  toPlanFileName,
  uniqueName,
  writePlan
} from '../src/library';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synchrony-lib-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('toPlanFileName', () => {
  it('should_slug_a_plain_title', () => {
    assert.equal(toPlanFileName('Refactor Auth'), 'refactor-auth.md');
  });

  it('should_collapse_punctuation_and_trim_dashes', () => {
    assert.equal(toPlanFileName('  Fix: the *thing*!  '), 'fix-the-thing.md');
  });

  it('should_not_double_the_extension', () => {
    assert.equal(toPlanFileName('notes.md'), 'notes.md');
  });

  it('should_strip_path_separators_from_a_title', () => {
    // A title is a label; no label needs to address the filesystem.
    assert.equal(toPlanFileName('../../etc/passwd'), 'etc-passwd.md');
    assert.equal(toPlanFileName('C:\\Windows\\System32'), 'c-windows-system32.md');
  });

  it('should_survive_a_title_with_nothing_usable_in_it', () => {
    assert.equal(toPlanFileName('///'), 'plan-untitled.md');
    assert.equal(toPlanFileName(''), 'plan-untitled.md');
  });

  it('should_escape_names_windows_reserves', () => {
    assert.equal(toPlanFileName('CON'), 'plan-con.md');
    assert.equal(toPlanFileName('lpt1'), 'plan-lpt1.md');
  });

  it('should_cap_an_absurdly_long_title', () => {
    const name = toPlanFileName('a'.repeat(500));

    assert.ok(name.length <= 63);
  });
});

describe('firstWords', () => {
  it('should_keep_only_the_first_three_words', () => {
    assert.equal(firstWords('add-monthly-repeat-option-to-scheduler'), 'add-monthly-repeat');
  });

  it('should_leave_a_name_already_short_enough_alone', () => {
    assert.equal(firstWords('fix-auth'), 'fix-auth');
  });

  it('should_treat_spaces_and_punctuation_as_word_breaks', () => {
    assert.equal(firstWords('Add monthly repeat: option'), 'Add-monthly-repeat');
  });

  it('should_drop_a_trailing_md_extension_rather_than_counting_it_as_a_word', () => {
    assert.equal(firstWords('fix-the-auth.md'), 'fix-the-auth');
  });

  it('should_hand_back_a_title_with_no_words_in_it_unchanged', () => {
    // Handing '' on instead would rob `toPlanFileName` of its own fallback.
    assert.equal(firstWords('///'), '///');
    assert.equal(toPlanFileName(firstWords('///')), 'plan-untitled.md');
  });
});

describe('uniqueName', () => {
  it('should_leave_a_free_name_alone', () => {
    assert.equal(uniqueName(['other.md'], 'plan.md'), 'plan.md');
  });

  it('should_append_a_counter_when_taken', () => {
    assert.equal(uniqueName(['plan.md'], 'plan.md'), 'plan-2.md');
    assert.equal(uniqueName(['plan.md', 'plan-2.md'], 'plan.md'), 'plan-3.md');
  });

  it('should_treat_names_case_insensitively', () => {
    // Windows and macOS filesystems do; assuming otherwise overwrites files.
    assert.equal(uniqueName(['Plan.md'], 'plan.md'), 'plan-2.md');
  });
});

describe('isInside', () => {
  it('should_accept_a_direct_child', () => {
    assert.equal(isInside('/library', '/library/plan.md'), true);
  });

  it('should_reject_traversal_out_of_the_library', () => {
    assert.equal(isInside('/library', '/library/../secrets.md'), false);
    assert.equal(isInside('/library', '/elsewhere/plan.md'), false);
  });

  it('should_reject_the_library_directory_itself', () => {
    assert.equal(isInside('/library', '/library'), false);
  });

  it('should_reject_a_sibling_with_a_shared_prefix', () => {
    assert.equal(isInside('/library', '/library-other/plan.md'), false);
  });
});

describe('parseUriList', () => {
  it('should_split_on_crlf', () => {
    assert.deepEqual(parseUriList('file:///c:/plans/a.md\r\nfile:///c:/plans/b.md'), [
      'file:///c:/plans/a.md',
      'file:///c:/plans/b.md'
    ]);
  });

  it('should_split_on_bare_lf', () => {
    assert.deepEqual(parseUriList('file:///plans/a.md\nfile:///plans/b.md'), [
      'file:///plans/a.md',
      'file:///plans/b.md'
    ]);
  });

  it('should_skip_comment_lines', () => {
    assert.deepEqual(parseUriList('# a comment\nfile:///plans/a.md'), ['file:///plans/a.md']);
  });

  it('should_skip_blank_and_whitespace_only_lines', () => {
    assert.deepEqual(parseUriList('\nfile:///plans/a.md\n   \n\n'), ['file:///plans/a.md']);
  });

  it('should_return_nothing_for_empty_input', () => {
    assert.deepEqual(parseUriList(''), []);
  });
});

describe('samePath', () => {
  it('should_match_a_path_against_itself', () => {
    assert.equal(samePath('/plans/nightly.md', '/plans/nightly.md'), true);
  });

  it('should_see_through_traversal_segments_to_the_same_file', () => {
    // Resolution happens before comparison, so `..` cannot smuggle a path past
    // a caller that already checked the plain form.
    assert.equal(samePath('/plans/sub/../nightly.md', '/plans/nightly.md'), true);
  });

  it('should_fold_case_when_told_the_filesystem_does', () => {
    assert.equal(samePath('/plans/Nightly.md', '/plans/nightly.md', true), true);
  });

  it('should_keep_case_significant_when_the_filesystem_does', () => {
    // On Linux these are two different files. Folding them would let a caller
    // write to a file it never named.
    assert.equal(samePath('/plans/Nightly.md', '/plans/nightly.md', false), false);
  });

  it('should_reject_a_different_file_in_the_same_folder', () => {
    assert.equal(samePath('/plans/nightly.md', '/plans/weekly.md'), false);
  });

  it('should_reject_the_same_basename_in_a_different_folder', () => {
    assert.equal(samePath('/plans/nightly.md', '/other/nightly.md'), false);
  });

  it('should_reject_a_name_that_merely_starts_with_the_scheduled_one', () => {
    assert.equal(samePath('/plans/nightly.md', '/plans/nightly.md.bak'), false);
  });

  // Separator equivalence is a Windows filesystem property. On Linux a
  // backslash is an ordinary character in a filename, and pretending otherwise
  // would widen the guard on exactly the platform that needs it narrow.
  it(
    'should_treat_mixed_separators_as_one_path_on_windows',
    { skip: process.platform !== 'win32' },
    () => {
      assert.equal(samePath('/plans/nightly.md', '\\plans\\nightly.md'), true);
    }
  );
});

describe('taskLabel', () => {
  // How a captured task reads as a single row in the activity-bar inbox. Nothing
  // here is ever written back — the file is the task, this is only the display.
  it('should_use_the_first_line_of_the_task', () => {
    assert.equal(taskLabel('Refactor the auth module\n'), 'Refactor the auth module');
  });

  it('should_skip_leading_blank_lines', () => {
    assert.equal(taskLabel('\n\n  \nWrite release notes\n'), 'Write release notes');
  });

  it('should_strip_the_marks_that_make_a_heading_or_a_bullet', () => {
    // A task may be edited in a real editor, where Markdown habits take over.
    assert.equal(taskLabel('# Add interval repeats'), 'Add interval repeats');
    assert.equal(taskLabel('- Add interval repeats'), 'Add interval repeats');
    assert.equal(taskLabel('1. Add interval repeats'), 'Add interval repeats');
  });

  it('should_keep_every_line_of_a_task_that_has_grown', () => {
    // A task grows past one line after Claude has asked about it, and those
    // lines are the description — the row wraps to hold them. The blank line
    // between the two is dropped.
    const label = taskLabel('Refactor the auth module\n\nContext: it predates SSO.\n');

    assert.equal(label, 'Refactor the auth module\nContext: it predates SSO.');
  });

  it('should_strip_the_marks_on_every_line_not_just_the_first', () => {
    assert.equal(
      taskLabel('# Refactor auth\n- check SSO\n- check tokens'),
      'Refactor auth\ncheck SSO\ncheck tokens'
    );
  });

  it('should_clip_a_task_too_long_for_a_row', () => {
    const label = taskLabel('a'.repeat(500));

    assert.ok(label.length <= 300, 'a pasted essay must not grow the row without bound');
    assert.ok(label.endsWith('…'), 'clipping must be visible, not silent');
  });

  it('should_give_an_empty_task_something_readable', () => {
    // An empty file would otherwise render as an unclickable blank row.
    assert.equal(taskLabel(''), '(empty task)');
    assert.equal(taskLabel('\n  \n'), '(empty task)');
  });
});

describe('planPath', () => {
  // A name is the only way the webview may address a plan, and this is the one
  // place a name becomes a path. Everything that reads, writes, schedules or
  // opens a plan comes through here, so what it refuses it refuses for all of them.
  it('should_resolve_a_plain_name_inside_the_library', () => {
    assert.equal(planPath(dir, 'nightly.md'), path.join(dir, 'nightly.md'));
  });

  it('should_flatten_a_traversing_name_back_into_the_library', () => {
    // Traversal is stripped rather than refused: a name is a label, not an
    // address, so the directory part is discarded and the result still lands in
    // the library. What matters is that nothing escapes, not how it is stopped.
    for (const bad of ['../outside.md', 'sub/../../outside.md', 'sub/nightly.md']) {
      const resolved = planPath(dir, bad);

      assert.equal(path.dirname(resolved), dir, `${bad} escaped the library`);
      assert.ok(isInside(dir, resolved));
    }
  });

  it('should_refuse_a_non_markdown_name', () => {
    assert.throws(() => planPath(dir, 'config.json'), /outside the plan library/);
    assert.throws(() => planPath(dir, 'passwd'), /outside the plan library/);
  });

  it('should_refuse_a_name_that_resolves_to_the_library_itself', () => {
    assert.throws(() => planPath(dir, ''), /outside the plan library/);
  });
});

describe('library CRUD', () => {
  it('should_create_a_plan_with_starter_content', () => {
    const plan = createPlan(dir, 'Refactor Auth');

    assert.equal(plan.name, 'refactor-auth.md');
    assert.match(readPlan(dir, plan.name), /^# refactor-auth/);
    assert.ok(fs.existsSync(plan.filePath));
  });

  it('should_deduplicate_a_repeated_title', () => {
    createPlan(dir, 'Nightly');
    const second = createPlan(dir, 'Nightly');

    assert.equal(second.name, 'nightly-2.md');
    assert.equal(listPlans(dir).length, 2);
  });

  it('should_round_trip_written_text', () => {
    const plan = createPlan(dir, 'Notes');
    writePlan(dir, plan.name, '# Edited\n');

    assert.equal(readPlan(dir, plan.name), '# Edited\n');
  });

  it('should_list_only_markdown_newest_first', () => {
    const old = createPlan(dir, 'Older');
    fs.utimesSync(old.filePath, new Date(0), new Date(0));
    createPlan(dir, 'Newer');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');

    const plans = listPlans(dir);

    assert.deepEqual(plans.map((p) => p.name), ['newer.md', 'older.md']);
  });

  it('should_return_an_empty_list_for_a_missing_directory', () => {
    assert.deepEqual(listPlans(path.join(dir, 'nope')), []);
  });

  it('should_rename_a_plan_and_keep_its_content', () => {
    const plan = createPlan(dir, 'Before');
    writePlan(dir, plan.name, 'body');

    const renamed = renamePlan(dir, plan.name, 'After');

    assert.equal(renamed.name, 'after.md');
    assert.equal(readPlan(dir, 'after.md'), 'body');
    assert.equal(fs.existsSync(plan.filePath), false);
  });

  it('should_be_a_no_op_when_renaming_to_the_same_title', () => {
    const plan = createPlan(dir, 'Same');

    const renamed = renamePlan(dir, plan.name, 'Same');

    assert.equal(renamed.name, plan.name);
    assert.equal(listPlans(dir).length, 1);
  });

  it('should_not_clobber_an_existing_plan_when_renaming_onto_it', () => {
    createPlan(dir, 'Taken');
    const other = createPlan(dir, 'Other');

    const renamed = renamePlan(dir, other.name, 'Taken');

    assert.equal(renamed.name, 'taken-2.md');
    assert.equal(listPlans(dir).length, 2);
  });

  it('should_duplicate_a_plan_with_its_content', () => {
    const plan = createPlan(dir, 'Source');
    writePlan(dir, plan.name, 'original');

    const copy = duplicatePlan(dir, plan.name);

    assert.equal(copy.name, 'source-copy.md');
    assert.equal(readPlan(dir, copy.name), 'original');
  });

  it('should_deduplicate_repeated_duplication', () => {
    const plan = createPlan(dir, 'Source');
    duplicatePlan(dir, plan.name);

    assert.equal(duplicatePlan(dir, plan.name).name, 'source-copy-2.md');
  });

  it('should_remove_a_plan', () => {
    const plan = createPlan(dir, 'Doomed');

    removePlan(dir, plan.name);

    assert.deepEqual(listPlans(dir), []);
  });
});

describe('archivePlan', () => {
  // Deleting moves the file here instead of unlinking it, so a misclick on a
  // hover-height button costs a re-import rather than the writing.
  let archive: string;

  beforeEach(() => {
    archive = path.join(dir, 'archive');
  });

  it('should_move_the_plan_out_of_the_library_and_into_the_archive', () => {
    const plan = createPlan(dir, 'Doomed');

    const archived = archivePlan(dir, archive, plan.name);

    assert.equal(archived.name, 'doomed.md');
    assert.equal(fs.existsSync(plan.filePath), false, 'the plan is still in the library');
    assert.equal(fs.existsSync(path.join(archive, 'doomed.md')), true);
    assert.deepEqual(listPlans(dir), []);
  });

  it('should_create_the_archive_when_it_does_not_exist_yet', () => {
    // Made on demand rather than by `ensureRoot`, so most folders never get one.
    const plan = createPlan(dir, 'First');

    assert.equal(fs.existsSync(archive), false);
    archivePlan(dir, archive, plan.name);

    assert.equal(fs.statSync(archive).isDirectory(), true);
  });

  it('should_keep_both_when_two_archived_plans_share_a_name', () => {
    // The second must cost a suffix, never the copy already archived.
    archivePlan(dir, archive, createPlan(dir, 'Notes', 'the first one').name);
    const second = archivePlan(dir, archive, createPlan(dir, 'Notes', 'the second one').name);

    assert.equal(second.name, 'notes-2.md');
    assert.equal(readPlan(archive, 'notes.md'), 'the first one');
    assert.equal(readPlan(archive, 'notes-2.md'), 'the second one');
  });

  it('should_refuse_to_archive_a_file_outside_the_library', () => {
    const outside = path.join(dir, '..', `sibling-${Date.now()}.md`);
    fs.writeFileSync(outside, 'keep me');

    try {
      assert.throws(() => archivePlan(dir, archive, `../${path.basename(outside)}`));
      assert.equal(fs.existsSync(outside), true);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('should_carry_the_contents_across_unchanged', () => {
    const body = '# Deploy\n\nRun the thing.\r\n\tindented\n';
    const plan = createPlan(dir, 'Deploy', body);

    const archived = archivePlan(dir, archive, plan.name);

    assert.equal(fs.readFileSync(archived.filePath, 'utf8'), body);
  });
});

describe('ensureLibrary and seeding', () => {
  it('should_report_creation_only_the_first_time', () => {
    const fresh = path.join(dir, 'library');

    assert.equal(ensureLibrary(fresh), true);
    assert.equal(ensureLibrary(fresh), false, 'a second call must not look like a first run');
  });

  it('should_seed_a_single_safe_starter_plan', () => {
    seedLibrary(dir);
    const plans = listPlans(dir);

    assert.equal(plans.length, 1);
    assert.match(readPlan(dir, plans[0].name), /Do not create, edit, move or delete any files/);
  });
});

describe('importFile', () => {
  // The single door into the library for a file from anywhere else on disk.
  let outside: string;

  beforeEach(() => {
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'synchrony-src-'));
  });

  afterEach(() => {
    fs.rmSync(outside, { recursive: true, force: true });
  });

  /** Writes a file outside the library and returns its path. */
  const source = (name: string, text: string): string => {
    const filePath = path.join(outside, name);
    fs.writeFileSync(filePath, text);
    return filePath;
  };

  it('should_copy_the_contents_under_a_name_derived_from_the_source', () => {
    const plan = importFile(dir, source('Nightly Deploy.md', '# Deploy\n'));

    assert.equal(plan.name, 'nightly-deploy.md');
    assert.equal(readPlan(dir, plan.name), '# Deploy\n');
    assert.ok(isInside(dir, plan.filePath), 'the copy must land inside the library');
  });

  it('should_file_the_copy_under_a_given_title_when_one_is_passed', () => {
    // How a generated plan gets its clamped three-word name without a second
    // write to disk and without a second door into the library.
    const plan = importFile(dir, source('something-long.md', '# Long\n'), 'three-word-name');

    assert.equal(plan.name, 'three-word-name.md');
    assert.equal(readPlan(dir, plan.name), '# Long\n');
  });

  it('should_still_use_the_source_file_name_when_no_title_is_given', () => {
    const plan = importFile(dir, source('something-long.md', '# Long\n'));

    assert.equal(plan.name, 'something-long.md');
  });

  it('should_leave_the_original_where_it_was', () => {
    // Copy, never move: the user's file is theirs, and Synchrony schedules the copy.
    const sourcePath = source('keep-me.md', 'original');

    importFile(dir, sourcePath);

    assert.equal(fs.existsSync(sourcePath), true);
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'original');
  });

  it('should_slug_an_awkward_name_the_generator_chose', () => {
    // A generated plan arrives named by Claude, so the name is not one the user
    // typed into a field with a guard on it. This is what stops it addressing
    // the filesystem or arriving with capitals, spaces and quotes in it.
    // Single quotes rather than double: Windows refuses to create the latter, so
    // no generator could produce that name in the first place.
    const plan = importFile(dir, source("Add 'Monthly' Repeat.md", '# Repeat\n'));

    assert.equal(plan.name, 'add-monthly-repeat.md');
  });

  it('should_not_overwrite_a_plan_that_already_has_that_name', () => {
    // Claude cannot see the library when it picks a name, so a collision is a
    // matter of time. It must cost a suffix, not an existing plan.
    createPlan(dir, 'Refactor auth', 'the original');

    const plan = importFile(dir, source('refactor-auth.md', 'the generated one'));

    assert.equal(plan.name, 'refactor-auth-2.md');
    assert.equal(readPlan(dir, 'refactor-auth.md'), 'the original');
  });

  it('should_deduplicate_against_a_plan_of_the_same_name', () => {
    createPlan(dir, 'Nightly');

    const plan = importFile(dir, source('nightly.md', 'from outside'));

    assert.equal(plan.name, 'nightly-2.md');
    assert.equal(readPlan(dir, 'nightly-2.md'), 'from outside');
    assert.equal(listPlans(dir).length, 2, 'the existing plan must survive the import');
  });

  it('should_import_the_same_source_twice_as_two_plans', () => {
    const sourcePath = source('twice.md', 'body');

    assert.equal(importFile(dir, sourcePath).name, 'twice.md');
    assert.equal(importFile(dir, sourcePath).name, 'twice-2.md');
  });

  it('should_create_the_library_when_it_does_not_exist_yet', () => {
    const fresh = path.join(dir, 'library');

    const plan = importFile(fresh, source('first.md', 'body'));

    assert.equal(readPlan(fresh, plan.name), 'body');
  });

  it('should_fail_rather_than_create_an_empty_plan_for_a_missing_source', () => {
    assert.throws(() => importFile(dir, path.join(outside, 'gone.md')), /ENOENT/);
    assert.deepEqual(listPlans(dir), []);
  });
});

describe('library — path traversal', () => {
  const escapes = ['../outside.md', '..\\outside.md', 'sub/../../outside.md'];

  it('should_refuse_to_read_outside_the_library', () => {
    for (const bad of escapes) {
      assert.throws(() => readPlan(dir, bad), /outside the plan library|ENOENT/);
    }
  });

  it('should_refuse_to_write_outside_the_library', () => {
    const outside = path.join(dir, '..', 'escaped.md');

    for (const bad of escapes) {
      try {
        writePlan(dir, bad, 'pwned');
      } catch {
        // Either refusing or failing to resolve is acceptable; writing is not.
      }
    }

    assert.equal(fs.existsSync(outside), false, 'a write escaped the library');
  });

  it('should_refuse_a_non_markdown_target', () => {
    assert.throws(() => writePlan(dir, 'config.json', '{}'), /outside the plan library/);
  });

  it('should_refuse_to_delete_outside_the_library', () => {
    const outside = path.join(dir, '..', `sibling-${Date.now()}.md`);
    fs.writeFileSync(outside, 'keep me');

    try {
      assert.throws(() => removePlan(dir, `../${path.basename(outside)}`));
      assert.equal(fs.existsSync(outside), true);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

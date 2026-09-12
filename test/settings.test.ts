import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { coerceSetting, GROUPS, SettingField, settingGroups } from '../src/settings';

/**
 * The real schema, read off disk rather than fixtured. The whole point of
 * generating the page from `package.json` is that the two cannot drift, and a
 * fixture would reintroduce exactly the second table this replaced.
 */
const PROPERTIES: Record<string, any> = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')
).contributes.configuration.properties;

const fieldFor = (key: string): SettingField => {
  const field = settingGroups(PROPERTIES)
    .flatMap((group) => group.fields)
    .find((f) => f.key === key);
  assert.ok(field, `no field for ${key}`);
  return field;
};

describe('settingGroups', () => {
  it('should_put_every_synchrony_setting_into_some_group', () => {
    // The tripwire for the GROUPS table falling behind the schema: a new
    // setting must reach the page, under a heading or under Other.
    const expected = Object.keys(PROPERTIES).map((key) => key.replace(/^synchrony\./, '')).sort();

    const shown = settingGroups(PROPERTIES).flatMap((group) => group.fields.map((f) => f.key));

    assert.deepEqual([...shown].sort(), expected);
    assert.equal(new Set(shown).size, shown.length, 'a setting appears on the page twice');
  });

  it('should_not_list_a_setting_the_manifest_no_longer_declares', () => {
    // The other direction from the test above, and the quieter failure: a
    // setting deleted from package.json but left in GROUPS just drops out of the
    // page, with nothing anywhere complaining.
    // Arrange.
    const declared = new Set(Object.keys(PROPERTIES));

    // Act.
    const listed = GROUPS.flatMap((group) => group.keys);

    // Assert.
    for (const key of listed) {
      assert.ok(declared.has(`synchrony.${key}`), `GROUPS lists synchrony.${key}, which no longer exists`);
    }
  });

  it('should_drop_a_group_with_nothing_in_it', () => {
    // A schema holding one property must not draw four empty headings.
    const groups = settingGroups({ 'synchrony.planModel': PROPERTIES['synchrony.planModel'] });

    assert.deepEqual(groups.map((g) => g.title), ['Planning']);
  });

  it('should_park_an_unlisted_setting_under_other', () => {
    const groups = settingGroups({
      'synchrony.somethingNew': { type: 'string', default: '', description: 'Added later.' }
    });

    assert.deepEqual(groups.map((g) => g.title), ['Other']);
    assert.equal(groups[0].fields[0].key, 'somethingNew');
  });

  it('should_carry_a_group_note_onto_the_built_group', () => {
    // The note is what stops the same closing sentence being repeated inside
    // every planStep description.
    const groups = settingGroups(PROPERTIES);
    const planning = groups.find((g) => g.title === 'Planning');
    const engines = groups.find((g) => g.title === 'Engines');

    assert.ok(planning?.note);
    assert.equal(engines?.note, undefined);
  });

  it('should_label_a_camel_case_key_as_a_sentence', () => {
    assert.equal(fieldFor('planModel').label, 'Plan model');
    assert.equal(fieldFor('showTerminalOnRun').label, 'Show terminal on run');
    assert.equal(fieldFor('logRetentionDays').label, 'Log retention days');
  });

  it('should_label_a_dotted_key_without_the_dot', () => {
    // The closing-step toggles are grouped under one key prefix; the dot is
    // structure in settings.json, not something to read on a page.
    assert.equal(fieldFor('planStep.changelog').label, 'Plan step changelog');
  });

  it('should_offer_the_account_default_first_for_the_plan_model', () => {
    // Empty means "pass no --model at all", which is the right answer until you
    // have a reason — so it has to be the one you land on.
    const options = fieldFor('planModel').options;

    assert.ok(options);
    assert.deepEqual(options[0], { value: '', label: 'Account default' });
  });

  it('should_strip_markdown_from_help_text', () => {
    // The webview renders help as plain text under CSP; backticks and asterisks
    // would reach the screen literally.
    const help = fieldFor('claudePath').help;

    assert.ok(!/[`*]/.test(help), `markdown survived: ${help}`);
    assert.match(help, /Path to the claude executable/);
  });

  it('should_carry_the_declared_range_onto_a_number_field', () => {
    const field = fieldFor('maxConcurrent');

    assert.equal(field.type, 'number');
    assert.equal(field.minimum, 1);
    assert.equal(field.maximum, 5);
  });

  it('should_leave_a_field_without_an_enum_with_no_options', () => {
    assert.equal(fieldFor('libraryPath').options, undefined);
  });
});

describe('coerceSetting', () => {
  it('should_accept_a_model_that_is_in_the_enum', () => {
    assert.equal(coerceSetting(fieldFor('planModel'), 'claude-sonnet-5'), 'claude-sonnet-5');
    assert.equal(coerceSetting(fieldFor('planModel'), ''), '');
  });

  it('should_reject_a_model_that_is_not_in_the_enum', () => {
    // The webview is the untrusted side of the boundary; nothing else stops a
    // bad id reaching settings.json and failing at planning time instead.
    assert.equal(coerceSetting(fieldFor('planModel'), 'gpt-4'), undefined);
  });

  it('should_clamp_a_number_to_its_declared_range', () => {
    const field = fieldFor('maxConcurrent');

    assert.equal(coerceSetting(field, 99), 5);
    assert.equal(coerceSetting(field, 0), 1);
    assert.equal(coerceSetting(field, 3), 3);
  });

  it('should_clamp_against_a_minimum_with_no_maximum', () => {
    assert.equal(coerceSetting(fieldFor('retryDelayMinutes'), -10), 1);
  });

  it('should_reject_a_non_finite_number', () => {
    // What an emptied number box sends. Clamping NaN would write the minimum,
    // so clearing a field would silently change it.
    const field = fieldFor('maxConcurrent');

    assert.equal(coerceSetting(field, Number.NaN), undefined);
    assert.equal(coerceSetting(field, Infinity), undefined);
    assert.equal(coerceSetting(field, '3'), undefined);
  });

  it('should_reject_a_non_boolean_for_a_boolean_field', () => {
    const field = fieldFor('showTerminalOnRun');

    assert.equal(coerceSetting(field, true), true);
    assert.equal(coerceSetting(field, false), false);
    assert.equal(coerceSetting(field, 'true'), undefined);
    assert.equal(coerceSetting(field, 1), undefined);
  });

  it('should_take_a_free_text_string_as_typed', () => {
    // No enum, so there is nothing to check it against — a path is whatever the
    // machine says it is, and the run is where a bad one is reported.
    assert.equal(coerceSetting(fieldFor('libraryPath'), 'D:\\plans'), 'D:\\plans');
    assert.equal(coerceSetting(fieldFor('libraryPath'), ''), '');
  });
});

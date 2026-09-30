import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentFor, isEffort, parseCodexModels, planChoice, resolveEffort } from '../src/agents';

/** A trimmed `codex debug models` payload: only the fields the parser reads. */
function catalog(models: object[]): string {
  return JSON.stringify({ models });
}

describe('parseCodexModels', () => {
  it('should_list_only_pickable_models_in_codex_priority_order_after_the_default', () => {
    const json = catalog([
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 12 },
      { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 43 },
      { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', priority: 1 }
    ]);

    assert.deepEqual(parseCodexModels(json), [
      { value: '', label: 'Codex default' },
      { value: 'gpt-6-astra', label: 'GPT-6-Astra' },
      { value: 'gpt-5.5', label: 'GPT-5.5' }
    ]);
  });

  it('should_fall_back_to_the_slug_when_a_model_has_no_display_name', () => {
    const json = catalog([{ slug: 'gpt-x', display_name: '', visibility: 'list', priority: 1 }]);
    assert.deepEqual(parseCodexModels(json)?.[1], { value: 'gpt-x', label: 'gpt-x' });
  });

  it('should_skip_entries_without_a_slug', () => {
    const json = catalog([
      { display_name: 'Nameless', visibility: 'list', priority: 1 },
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 2 }
    ]);
    assert.deepEqual(parseCodexModels(json)?.map((m) => m.value), ['', 'gpt-5.5']);
  });

  it('should_return_undefined_for_output_that_is_not_json', () => {
    assert.equal(parseCodexModels('error: unknown subcommand'), undefined);
  });

  it('should_return_undefined_when_the_models_array_is_missing', () => {
    assert.equal(parseCodexModels(JSON.stringify({ items: [] })), undefined);
    assert.equal(parseCodexModels('null'), undefined);
  });

  it('should_return_undefined_when_nothing_is_pickable', () => {
    const json = catalog([{ slug: 'codex-auto-review', display_name: 'Review', visibility: 'hide', priority: 1 }]);
    assert.equal(parseCodexModels(json), undefined);
  });
});

describe('resolveEffort', () => {
  const claude = agentFor('claude');
  const codex = agentFor('codex');

  it('should_prefer_the_plans_own_level_over_the_setting', () => {
    assert.equal(resolveEffort(claude, 'low', () => 'max'), 'low');
  });

  it('should_fall_back_to_the_engines_own_setting', () => {
    const settings: Record<string, unknown> = { effortClaude: 'high', effortCodex: 'ultra' };

    assert.equal(resolveEffort(claude, undefined, (key) => settings[key]), 'high');
    assert.equal(resolveEffort(codex, undefined, (key) => settings[key]), 'ultra');
  });

  it('should_ignore_a_level_this_engine_does_not_list', () => {
    // `ultra` is a Codex level, not a Claude one, and `minimal` is opencode's.
    assert.equal(resolveEffort(claude, 'ultra', () => 'high'), 'high');
    assert.equal(resolveEffort(claude, undefined, () => 'minimal'), '');
    assert.equal(resolveEffort(claude, 'high & calc', () => undefined), '');
  });

  it('should_ignore_a_setting_that_is_not_a_string', () => {
    assert.equal(resolveEffort(claude, undefined, () => 3), '');
    assert.equal(resolveEffort(claude, undefined, () => ['high']), '');
  });

  it('should_return_empty_when_nothing_is_set', () => {
    assert.equal(resolveEffort(claude, undefined, () => undefined), '');
    assert.equal(resolveEffort(claude, '', () => ''), '');
  });
});

describe('isEffort', () => {
  it('should_accept_a_level_any_engine_lists_and_nothing_else', () => {
    assert.ok(isEffort('high'));
    assert.ok(isEffort('ultra'));
    assert.ok(isEffort('minimal'));
    assert.ok(!isEffort(''));
    assert.ok(!isEffort('HIGH'));
    assert.ok(!isEffort('high & calc'));
    assert.ok(!isEffort(undefined));
  });
});

describe('planChoice — effort', () => {
  it('should_return_the_current_engines_effort_setting', () => {
    const settings: Record<string, unknown> = {
      planAgent: 'codex',
      effortClaude: 'low',
      effortCodex: 'xhigh'
    };

    assert.equal(planChoice((key) => settings[key]).effort, 'xhigh');
  });

  it('should_return_empty_when_the_engine_is_left_at_its_default', () => {
    assert.equal(planChoice(() => undefined).effort, '');
  });
});

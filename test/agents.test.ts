import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCodexModels } from '../src/agents';

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

import { AgentId } from './types';

/**
 * The engines Synchrony can run a plan through, and the models each one offers.
 *
 * One flat table rather than a registry of classes: an engine is four facts and
 * a list, and every other module reads it by id. `claude` is first because it is
 * the default — a series with no `agent` is a Claude series.
 *
 * The Claude and opencode model lists are curated rather than queried, because
 * those CLIs cannot enumerate what your account can reach: `claude --help`
 * documents `--model` by example only, and `opencode models` prints just the
 * providers you have logged into. A curated list therefore goes stale in one
 * direction only — it can name a model you cannot run — so the manager offers a
 * **Custom…** box beside it and `edit.ts` validates whatever you type by shape.
 * Codex is the exception: `codex debug models` prints its live catalogue, which
 * replaces `CODEX_MODELS` at startup.
 *
 * No `vscode` import, so tests and `package.json` generation can both read it.
 */

export interface ModelChoice {
  /** Passed to the engine's model flag verbatim. '' means the engine's default. */
  value: string;
  label: string;
}

export interface Agent {
  id: AgentId;
  label: string;
  /** The `synchrony.` setting holding this engine's executable path. */
  pathSetting: string;
  /** Default executable, resolved from PATH. */
  exe: string;
  models: ModelChoice[];
  /** The `synchrony.` setting holding the model the Tasks panel uses on this engine. */
  planModelSetting: string;
}

/**
 * Pinned IDs run a specific model; the bare aliases track the newest of a
 * family. Account default is first because it is the right answer until you
 * have a reason.
 */
export const CLAUDE_MODELS: ModelChoice[] = [
  { value: '', label: 'Account default' },
  { value: 'claude-opus-5-5', label: 'Opus 5.5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1' },
  { value: 'claude-fable-5', label: 'Fable 5' },
  { value: 'opus', label: 'Opus (latest)' },
  { value: 'sonnet', label: 'Sonnet (latest)' },
  { value: 'haiku', label: 'Haiku (latest)' },
  { value: 'fable', label: 'Fable (latest)' }
];

/**
 * opencode's own hosted catalogue, which needs no login. Anything else it can
 * route to — Kimi, the GPT family, a local Ollama model — depends on providers
 * you have added with `opencode providers login`, so those are reached through
 * **Custom…** rather than listed here as though they were available.
 */
export const OPENCODE_MODELS: ModelChoice[] = [
  { value: '', label: 'opencode default' },
  { value: 'opencode/big-pickle', label: 'Big Pickle' },
  { value: 'opencode/deepseek-v4-flash-free', label: 'DeepSeek V4 Flash' },
  { value: 'opencode/laguna-s-2.1-free', label: 'Laguna S 2.1' },
  { value: 'opencode/ling-3.0-flash-free', label: 'Ling 3.0 Flash' },
  { value: 'opencode/mimo-v2.5-free', label: 'MiMo v2.5' },
  { value: 'opencode/nemotron-3-ultra-free', label: 'Nemotron 3 Ultra' },
  { value: 'opencode/north-mini-code-free', label: 'North Mini Code' }
];

/**
 * The fallback only. At startup `extension.ts` replaces it with Codex's own
 * catalogue (`codex debug models`, parsed by `parseCodexModels`), so this list
 * is what you see only when that command fails.
 */
export const CODEX_MODELS: ModelChoice[] = [
  { value: '', label: 'Codex default' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' }
];

/** One entry of `codex debug models`, reduced to the fields read here. */
interface CodexCatalogEntry {
  slug: string;
  display_name: string;
  /** 'list' for pickable models; 'hide' for internal ones such as auto-review. */
  visibility: string;
  /** Lower sorts first — Codex's own picker order. */
  priority: number;
}

/**
 * Turns the JSON `codex debug models` prints into dropdown choices, or
 * undefined when it is not the shape expected, so the caller keeps
 * `CODEX_MODELS` rather than showing an empty list.
 */
export function parseCodexModels(json: string): ModelChoice[] | undefined {
  let entries: CodexCatalogEntry[];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed?.models)) {
      return undefined;
    }
    entries = parsed.models.filter(
      (m: CodexCatalogEntry) => typeof m?.slug === 'string' && m.slug !== ''
    );
  } catch {
    return undefined;
  }

  // Only what Codex's own picker lists, in its order. Hidden entries are
  // internal, such as the model behind auto-review.
  const picked: ModelChoice[] = entries
    .filter((m) => m.visibility === 'list')
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((m) => ({ value: m.slug, label: m.display_name || m.slug }));

  return picked.length ? [{ value: '', label: 'Codex default' }, ...picked] : undefined;
}

export const AGENTS: Agent[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    pathSetting: 'claudePath',
    exe: 'claude',
    models: CLAUDE_MODELS,
    planModelSetting: 'planModel'
  },
  {
    id: 'opencode',
    label: 'opencode',
    pathSetting: 'opencodePath',
    exe: 'opencode',
    models: OPENCODE_MODELS,
    planModelSetting: 'planModelOpencode'
  },
  {
    id: 'codex',
    label: 'Codex',
    pathSetting: 'codexPath',
    exe: 'codex',
    models: CODEX_MODELS,
    planModelSetting: 'planModelCodex'
  }
];

export const DEFAULT_AGENT: AgentId = 'claude';

export function isAgentId(value: unknown): value is AgentId {
  return AGENTS.some((agent) => agent.id === value);
}

/** The engine a series runs on. Absent means Claude. */
export function agentFor(id: AgentId | undefined): Agent {
  return AGENTS.find((agent) => agent.id === id) ?? AGENTS[0];
}

/** The engine and model the Tasks panel (and Revise) use. `read` is a settings getter. */
export function planChoice(read: (key: string) => unknown): { agent: Agent; model: string } {
  const id = read('planAgent');
  const agent = agentFor(isAgentId(id) ? id : DEFAULT_AGENT);
  const model = read(agent.planModelSetting);
  return { agent, model: typeof model === 'string' ? model : '' };
}

import { AgentId } from './types';

/**
 * The engines Chronos can run a plan through, and the models each one offers.
 *
 * One flat table rather than a registry of classes: an engine is four facts and
 * a list, and every other module reads it by id. `claude` is first because it is
 * the default — a series with no `agent` is a Claude series.
 *
 * The model lists are curated rather than queried, because the CLIs cannot
 * enumerate what your account can reach: `claude --help` documents `--model` by
 * example only, and `opencode models` prints just the providers you have logged
 * into. A curated list therefore goes stale in one direction only — it can name
 * a model you cannot run — so the manager offers a **Custom…** box beside it and
 * `edit.ts` validates whatever you type by shape.
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
  /** The `chronos.` setting holding this engine's executable path. */
  pathSetting: string;
  /** Default executable, resolved from PATH. */
  exe: string;
  models: ModelChoice[];
}

/**
 * Pinned IDs run a specific model; the bare aliases track the newest of a
 * family. Account default is first because it is the right answer until you
 * have a reason.
 */
export const CLAUDE_MODELS: ModelChoice[] = [
  { value: '', label: 'Account default' },
  { value: 'claude-opus-5', label: 'Opus 5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { value: 'claude-fable-5', label: 'Fable 5' },
  { value: 'opus', label: 'Opus (latest)' },
  { value: 'sonnet', label: 'Sonnet (latest)' },
  { value: 'haiku', label: 'Haiku (latest)' }
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
 * Codex CLI accepts any reachable model id through `--model`, but the manager
 * only lists the current Codex family explicitly. Older Codex model aliases are
 * deliberately left to **Custom...** so this list does not advertise deprecated
 * choices as first-class options.
 */
export const CODEX_MODELS: ModelChoice[] = [
  { value: '', label: 'Codex default' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' }
];

export const AGENTS: Agent[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    pathSetting: 'claudePath',
    exe: 'claude',
    models: CLAUDE_MODELS
  },
  {
    id: 'opencode',
    label: 'opencode',
    pathSetting: 'opencodePath',
    exe: 'opencode',
    models: OPENCODE_MODELS
  },
  {
    id: 'codex',
    label: 'Codex',
    pathSetting: 'codexPath',
    exe: 'codex',
    models: CODEX_MODELS
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

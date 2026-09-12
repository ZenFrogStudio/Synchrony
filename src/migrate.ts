import { SynchronyState, SCHEMA_VERSION } from './types';

/**
 * Schema migration. Pure — no `vscode` import — so the ladder can be exercised
 * by the plain Node test runner.
 *
 * This exists because the original version check demanded exact equality:
 * bumping SCHEMA_VERSION would have moved every existing user's series and run
 * history to a backup key and started them empty. A version gate is not a
 * migration path.
 */

/** Structurally a Synchrony state of *some* version, before any upgrading. */
function isSynchronyShaped(raw: unknown): raw is SynchronyState {
  if (!raw || typeof raw !== 'object') {
    return false;
  }
  const state = raw as Partial<SynchronyState>;
  return (
    typeof state.schemaVersion === 'number' &&
    Array.isArray(state.series) &&
    Array.isArray(state.runs)
  );
}

/**
 * Upgrades stored state to the current schema, or returns undefined if the
 * shape is unrecognisable and the caller should back it up instead.
 *
 * State from a *newer* Synchrony is also refused: guessing at a shape written by
 * a future version risks corrupting it on the next write.
 */
export function migrate(raw: unknown): SynchronyState | undefined {
  if (!isSynchronyShaped(raw)) {
    return undefined;
  }

  let state: SynchronyState = raw;
  let version = state.schemaVersion;
  if (version > SCHEMA_VERSION || version < 1) {
    return undefined;
  }

  if (version === 1) {
    state = v1ToV2(state);
    version = 2;
  }

  // v2 → v3 added `result` and `resultPath` to TaskRun. Both are optional, so
  // v2 state is already valid v3 and there is nothing to transform. The rung is
  // written out rather than implied so the next real step has an obvious home.
  if (version === 2) {
    version = 3;
  }

  if (version !== SCHEMA_VERSION) {
    return undefined;
  }

  return { ...state, schemaVersion: SCHEMA_VERSION };
}

/**
 * v1 overloaded `enabled: false` to mean both "user paused this" and "this
 * one-shot already fired". v2 splits the second meaning out into `spent`.
 *
 * A disabled one-shot that has a run on record was retired by the scheduler,
 * not paused by the user, so it is re-read as spent-and-enabled. A disabled
 * one-shot with no runs was genuinely paused and is left alone.
 */
function v1ToV2(state: SynchronyState): SynchronyState {
  const hasRun = new Set(state.runs.map((run) => run.seriesId));

  return {
    ...state,
    series: state.series.map((series) => {
      if (series.recurrence || series.enabled || !hasRun.has(series.id)) {
        return series;
      }
      return { ...series, enabled: true, spent: true };
    })
  };
}

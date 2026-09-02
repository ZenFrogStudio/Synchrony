/**
 * The manager's Settings page, derived from the configuration schema already
 * declared in `package.json` rather than from a second hand-written table.
 *
 * There is then one source of truth for types, defaults, ranges and help text,
 * and adding a setting to `package.json` puts it on the page for free — the
 * failure mode of two tables is a setting that exists but has no control, which
 * nothing would ever notice.
 *
 * No `vscode` import, same rule as `src/agents.ts`: it is what lets the test
 * runner load this file and read the real schema off disk.
 */

export interface SettingField {
  /** Short key with no `chronos.` prefix — what `config.get` and `config.update` take. */
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean';
  default: unknown;
  /** Present only when the property declares an `enum`. */
  options?: { value: string; label: string }[];
  help: string;
  minimum?: number;
  maximum?: number;
}

export interface SettingGroup {
  title: string;
  /** Something true of every field under the heading, so no field has to repeat it. */
  note?: string;
  fields: SettingField[];
}

const PREFIX = 'chronos.';

/**
 * Which heading each setting sits under, and the order within it. The one thing
 * here that is not derived from the schema, because "these four belong together"
 * is a judgement `package.json` has nowhere to record.
 *
 * Exported so a test can check it the other way round: a key left here after its
 * setting is deleted from the manifest drops out of `settingGroups` silently.
 */
export const GROUPS: { title: string; note?: string; keys: string[] }[] = [
  {
    title: 'Planning',
    note: 'These shape the plans Chronos generates from now on. Plans already in your library are untouched.',
    keys: [
      'planModel',
      'planStep.tests',
      'planStep.version',
      'planStep.changelog',
      'planStep.rebuild',
      'planStep.reinstall',
      'planStep.commit'
    ]
  },
  { title: 'Engines', keys: ['claudePath', 'opencodePath', 'codexPath'] },
  { title: 'Locations', keys: ['libraryPath', 'resultsPath'] },
  {
    title: 'Running',
    keys: ['showTerminalOnRun', 'maxConcurrent', 'maxRetries', 'retryDelayMinutes']
  },
  {
    title: 'Limits',
    keys: ['graceWindowMinutes', 'idleTimeoutMinutes', 'maxRuntimeMinutes', 'logRetentionDays']
  }
];

/**
 * Takes `contributes.configuration.properties` verbatim — keys still carrying
 * their `chronos.` prefix — and returns the page. Empty groups are dropped.
 */
export function settingGroups(properties: Record<string, any>): SettingGroup[] {
  const remaining = new Map<string, any>(
    Object.entries(properties ?? {}).map(([full, prop]) => [
      full.startsWith(PREFIX) ? full.slice(PREFIX.length) : full,
      prop
    ])
  );

  const groups: SettingGroup[] = GROUPS.map((group) => ({
    title: group.title,
    note: group.note,
    fields: group.keys.flatMap((key) => {
      const prop = remaining.get(key);
      if (!prop) {
        return [];
      }
      remaining.delete(key);
      return [toField(key, prop)];
    })
  }));

  // A setting added to package.json and forgotten in GROUPS still appears here,
  // rather than vanishing from the only page that shows it.
  if (remaining.size) {
    groups.push({
      title: 'Other',
      fields: [...remaining].map(([key, prop]) => toField(key, prop))
    });
  }

  return groups.filter((group) => group.fields.length > 0);
}

function toField(key: string, prop: any): SettingField {
  const field: SettingField = {
    key,
    label: labelFor(key),
    type: prop.type,
    default: prop.default,
    // The webview renders this as plain text under CSP, so the marks that would
    // have been formatting are stripped rather than parsed.
    help: String(prop.markdownDescription ?? prop.description ?? '').replace(/[`*]/g, '')
  };

  if (Array.isArray(prop.enum)) {
    const descriptions: string[] = prop.enumDescriptions ?? [];
    field.options = prop.enum.map((value: string, i: number) => ({
      value,
      label: descriptions[i] ?? value
    }));
  }
  if (typeof prop.minimum === 'number') {
    field.minimum = prop.minimum;
  }
  if (typeof prop.maximum === 'number') {
    field.maximum = prop.maximum;
  }

  return field;
}

/** `showTerminalOnRun` → `Show terminal on run`, `planStep.tests` → `Plan step
 *  tests`. Derived rather than listed, so a label cannot drift from the key it
 *  belongs to. */
function labelFor(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\./g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The guard on a value arriving from the webview, which is the untrusted side of
 * the boundary. `undefined` means "will not accept" — the caller drops it and
 * re-posts, so the control snaps back to what is actually stored.
 */
export function coerceSetting(field: SettingField, value: unknown): unknown | undefined {
  if (field.type === 'boolean') {
    return typeof value === 'boolean' ? value : undefined;
  }

  if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return undefined;
    }
    // Clamped rather than refused: a typed 99 is a request for "as high as it
    // goes", and writing the ceiling answers it.
    let clamped = value;
    if (typeof field.minimum === 'number') {
      clamped = Math.max(field.minimum, clamped);
    }
    if (typeof field.maximum === 'number') {
      clamped = Math.min(field.maximum, clamped);
    }
    return clamped;
  }

  if (field.options) {
    return field.options.some((option) => option.value === value) ? value : undefined;
  }

  return String(value);
}

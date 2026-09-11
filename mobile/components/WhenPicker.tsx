import { StyleSheet, Text, TextInput, View } from 'react-native';
import { PermissionMode, Recurrence, Series } from '../lib/api';
import { palette } from '../lib/theme';
import { Chip } from './ui';

/**
 * The shapes `seriesEdit`'s recurrence validation accepts (`src/edit.ts`), plus
 * the one-time case. No native date-picker dependency — a preset row and a
 * plain ISO text field, validated by round-trip `Date` parsing.
 */
export type WhenValue =
  | { repeat: 'once'; at: string }
  | { repeat: 'daily'; timeLocal: string }
  | { repeat: 'weekly'; timeLocal: string; daysOfWeek: number[] }
  | { repeat: 'monthly'; timeLocal: string; dayOfMonth: number };

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const REPEATS: WhenValue['repeat'][] = ['once', 'daily', 'weekly', 'monthly'];
const REPEAT_LABEL: Record<WhenValue['repeat'], string> = {
  once: 'Once',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly'
};

export function isValidWhen(v: WhenValue): boolean {
  if (v.repeat === 'once') {
    return !!v.at && !Number.isNaN(Date.parse(v.at));
  }
  if (!TIME_PATTERN.test(v.timeLocal)) return false;
  if (v.repeat === 'weekly') return v.daysOfWeek.length > 0 && v.daysOfWeek.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (v.repeat === 'monthly') return Number.isInteger(v.dayOfMonth) && v.dayOfMonth >= 1 && v.dayOfMonth <= 31;
  return true;
}

export function describeWhen(v: WhenValue): string {
  if (v.repeat === 'once') {
    const t = Date.parse(v.at);
    if (Number.isNaN(t)) return 'once · (invalid date)';
    return `once · ${new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  }
  if (v.repeat === 'daily') return `daily ${v.timeLocal}`;
  if (v.repeat === 'weekly') return `${v.daysOfWeek.slice().sort().map((d) => DAY_NAMES[d]).join(' ')} ${v.timeLocal}`;
  return `day ${v.dayOfMonth} ${v.timeLocal}`;
}

/** `schedule_plan`'s flat args shape. */
export function toScheduleArgs(v: WhenValue): {
  repeat: WhenValue['repeat'];
  at?: string;
  timeLocal?: string;
  daysOfWeek?: number[];
  dayOfMonth?: number;
} {
  if (v.repeat === 'once') return { repeat: 'once', at: v.at };
  if (v.repeat === 'daily') return { repeat: 'daily', timeLocal: v.timeLocal };
  if (v.repeat === 'weekly') return { repeat: 'weekly', timeLocal: v.timeLocal, daysOfWeek: v.daysOfWeek };
  return { repeat: 'monthly', timeLocal: v.timeLocal, dayOfMonth: v.dayOfMonth };
}

/** `update_series`'s patch shape — `seriesEdit`'s `recurrence`/`nextRunAt` keys. */
export function toRecurrencePatch(v: WhenValue): { recurrence: Recurrence | null; nextRunAt?: string } {
  if (v.repeat === 'once') return { recurrence: null, nextRunAt: new Date(v.at).toISOString() };
  if (v.repeat === 'daily') return { recurrence: { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timeLocal: v.timeLocal } };
  if (v.repeat === 'weekly') return { recurrence: { daysOfWeek: v.daysOfWeek, timeLocal: v.timeLocal } };
  return { recurrence: { daysOfWeek: [], timeLocal: v.timeLocal, dayOfMonth: v.dayOfMonth } };
}

/** An existing series' timing, read back into the shape this component edits. */
export function fromSeries(s: Series): WhenValue {
  if (!s.recurrence) return { repeat: 'once', at: s.nextRunAt };
  if (s.recurrence.dayOfMonth) return { repeat: 'monthly', timeLocal: s.recurrence.timeLocal, dayOfMonth: s.recurrence.dayOfMonth };
  if (s.recurrence.daysOfWeek.length === 7) return { repeat: 'daily', timeLocal: s.recurrence.timeLocal };
  return { repeat: 'weekly', timeLocal: s.recurrence.timeLocal, daysOfWeek: s.recurrence.daysOfWeek };
}

function atLocalTime(hours: number, minutes: number, forceTomorrow: boolean): string {
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  if (forceTomorrow || d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

interface WhenPickerProps {
  value: WhenValue;
  onChange: (next: WhenValue) => void;
  /** Chain starts are one-time only — hides the repeat row and forces `once`. */
  allowRecurrence?: boolean;
}

export function WhenPicker({ value, onChange, allowRecurrence = true }: WhenPickerProps) {
  function setRepeat(repeat: WhenValue['repeat']) {
    if (repeat === value.repeat) return;
    const timeLocal = value.repeat === 'once' ? '09:00' : value.timeLocal;
    if (repeat === 'once') return onChange({ repeat: 'once', at: new Date().toISOString() });
    if (repeat === 'daily') return onChange({ repeat: 'daily', timeLocal });
    if (repeat === 'weekly') return onChange({ repeat: 'weekly', timeLocal, daysOfWeek: [new Date().getDay()] });
    return onChange({ repeat: 'monthly', timeLocal, dayOfMonth: new Date().getDate() });
  }

  return (
    <View>
      {allowRecurrence ? (
        <View style={styles.chipsRow}>
          {REPEATS.map((r) => (
            <Chip key={r} label={REPEAT_LABEL[r]} selected={value.repeat === r} onPress={() => setRepeat(r)} />
          ))}
        </View>
      ) : null}

      {value.repeat === 'once' ? (
        <View style={{ marginTop: 12 }}>
          <View style={styles.chipsRow}>
            <Chip label="Now" onPress={() => onChange({ repeat: 'once', at: new Date().toISOString() })} />
            <Chip
              label="+1 hour"
              onPress={() => onChange({ repeat: 'once', at: new Date(Date.now() + 3_600_000).toISOString() })}
            />
            <Chip label="Tonight 02:00" onPress={() => onChange({ repeat: 'once', at: atLocalTime(2, 0, false) })} />
            <Chip label="Tomorrow 09:00" onPress={() => onChange({ repeat: 'once', at: atLocalTime(9, 0, true) })} />
          </View>
          <Text style={styles.label}>Date & time (ISO)</Text>
          <TextInput
            value={value.at}
            onChangeText={(text) => onChange({ repeat: 'once', at: text })}
            placeholder="2026-09-12T02:00:00.000Z"
            placeholderTextColor={palette.textDim}
            style={[styles.input, !isValidWhen(value) && styles.inputInvalid]}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.hint}>{isValidWhen(value) ? describeWhen(value) : 'Not a valid date/time.'}</Text>
        </View>
      ) : (
        <View style={{ marginTop: 12 }}>
          <Text style={styles.label}>Time (24h HH:MM)</Text>
          <TextInput
            value={value.timeLocal}
            onChangeText={(text) => onChange({ ...value, timeLocal: text })}
            placeholder="09:00"
            placeholderTextColor={palette.textDim}
            style={[styles.input, !TIME_PATTERN.test(value.timeLocal) && styles.inputInvalid]}
            autoCapitalize="none"
            autoCorrect={false}
          />

          {value.repeat === 'weekly' ? (
            <View style={{ marginTop: 10 }}>
              <Text style={styles.label}>Days</Text>
              <View style={styles.chipsRow}>
                {DAY_NAMES.map((d, i) => (
                  <Chip
                    key={d}
                    label={d}
                    selected={value.daysOfWeek.includes(i)}
                    onPress={() => {
                      const days = value.daysOfWeek.includes(i)
                        ? value.daysOfWeek.filter((x) => x !== i)
                        : [...value.daysOfWeek, i];
                      onChange({ ...value, daysOfWeek: days });
                    }}
                  />
                ))}
              </View>
            </View>
          ) : null}

          {value.repeat === 'monthly' ? (
            <View style={{ marginTop: 10 }}>
              <Text style={styles.label}>Day of month (1–31)</Text>
              <TextInput
                value={String(value.dayOfMonth)}
                onChangeText={(text) => onChange({ ...value, dayOfMonth: Number(text) || 0 })}
                keyboardType="number-pad"
                placeholderTextColor={palette.textDim}
                style={[styles.input, !isValidWhen(value) && styles.inputInvalid]}
              />
            </View>
          ) : null}

          <Text style={styles.hint}>{describeWhen(value)}</Text>
        </View>
      )}
    </View>
  );
}

export const AGENT_LABEL: Record<string, string> = { claude: 'Claude', opencode: 'opencode', codex: 'Codex' };
export const PERMISSION_MODES: PermissionMode[] = ['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'manual', 'plan'];

const styles = StyleSheet.create({
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8
  },
  label: {
    color: palette.textDim,
    fontSize: 12,
    marginTop: 10,
    marginBottom: 6
  },
  hint: {
    color: palette.textDim,
    fontSize: 12,
    marginTop: 6
  },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    color: palette.text
  },
  inputInvalid: {
    borderColor: palette.danger
  }
});

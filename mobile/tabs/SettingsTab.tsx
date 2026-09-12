import { useEffect, useState } from 'react';
import { ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { InstanceSnapshot, SettingField, updateSetting } from '../lib/api';
import { palette, shared } from '../lib/theme';
import { Banner, Chip } from '../components/ui';

interface Props {
  snapshot: InstanceSnapshot;
  refresh: () => void;
  refreshing: boolean;
}

type FieldStatus = { kind: 'applied' | 'refused' | 'queued'; note?: string };

/**
 * Mirrors the desktop manager's generated Settings page: same groups, same
 * fields, same `synchrony.*` keys, driven by the `settingGroups`/`values` the
 * snapshot already carries off `read_instance`.
 */
export default function SettingsTab({ snapshot, refresh }: Props) {
  const [status, setStatus] = useState<Record<string, FieldStatus>>({});
  const { instance, settings } = snapshot;

  async function apply(field: SettingField, value: unknown) {
    try {
      const text = await updateSetting(instance, field.key, value);
      if (text.startsWith('Applied')) {
        setStatus((prev) => ({ ...prev, [field.key]: { kind: 'applied' } }));
        refresh();
      } else {
        setStatus((prev) => ({ ...prev, [field.key]: { kind: 'queued', note: text } }));
      }
    } catch (err) {
      setStatus((prev) => ({
        ...prev,
        [field.key]: { kind: 'refused', note: err instanceof Error ? err.message : 'That setting was refused.' }
      }));
    }
  }

  return (
    <ScrollView style={{ flex: 1 }}>
      <Text style={{ color: palette.textDim, fontSize: 12, marginBottom: 12 }}>
        Settings are global — they apply to every Synchrony instance on the desktop.
      </Text>

      {!settings ? (
        <Banner kind="info" message="No editor window open — settings unavailable until one is." />
      ) : (
        settings.groups.map((group) => (
          <View key={group.title} style={[shared.card, { marginBottom: 14 }]}>
            <Text style={{ color: palette.text, fontWeight: '600', fontSize: 15 }}>{group.title}</Text>
            {group.note ? <Text style={{ color: palette.textDim, fontSize: 12, marginTop: 4 }}>{group.note}</Text> : null}
            {group.fields.map((field) => (
              <FieldRow
                key={field.key}
                field={field}
                value={settings.values[field.key] ?? field.default}
                status={status[field.key]}
                onApply={(value) => apply(field, value)}
              />
            ))}
          </View>
        ))
      )}
    </ScrollView>
  );
}

function FieldRow({
  field,
  value,
  status,
  onApply
}: {
  field: SettingField;
  value: unknown;
  status?: FieldStatus;
  onApply: (value: unknown) => void;
}) {
  const range =
    field.type === 'number' && (field.minimum !== undefined || field.maximum !== undefined)
      ? field.minimum !== undefined && field.maximum !== undefined
        ? `${field.minimum}–${field.maximum}`
        : field.minimum !== undefined
          ? `Minimum ${field.minimum}`
          : `Maximum ${field.maximum}`
      : null;

  return (
    <View style={{ marginTop: 14 }}>
      <Text style={{ color: palette.text, fontSize: 14 }}>{field.label}</Text>
      {field.help ? <Text style={{ color: palette.textDim, fontSize: 12, marginTop: 2 }}>{field.help}</Text> : null}

      <View style={{ marginTop: 8 }}>
        {field.options ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {field.options.map((opt) => (
              <Chip key={opt.value} label={opt.label} selected={value === opt.value} onPress={() => onApply(opt.value)} />
            ))}
          </View>
        ) : field.type === 'boolean' ? (
          <Switch value={!!value} onValueChange={(v) => onApply(v)} />
        ) : field.type === 'number' ? (
          <NumberField value={value} onApply={onApply} />
        ) : (
          <StringField value={value} onApply={onApply} />
        )}
      </View>

      {range ? <Text style={{ color: palette.textDim, fontSize: 11, marginTop: 4 }}>{range}</Text> : null}

      {status ? (
        <Text
          style={{
            color: status.kind === 'refused' ? palette.danger : status.kind === 'applied' ? palette.status.success : palette.textDim,
            fontSize: 11,
            marginTop: 4
          }}
        >
          {status.kind === 'applied' ? 'Applied.' : (status.note ?? (status.kind === 'queued' ? 'Queued.' : 'Refused.'))}
        </Text>
      ) : null}
    </View>
  );
}

function NumberField({ value, onApply }: { value: unknown; onApply: (value: unknown) => void }) {
  const [text, setText] = useState(String(value ?? ''));
  useEffect(() => setText(String(value ?? '')), [value]);

  return (
    <TextInput
      value={text}
      onChangeText={setText}
      onEndEditing={() => {
        const n = Number(text);
        if (Number.isFinite(n)) onApply(n);
        else setText(String(value ?? ''));
      }}
      keyboardType="number-pad"
      style={textInputStyle}
      placeholderTextColor={palette.textDim}
    />
  );
}

function StringField({ value, onApply }: { value: unknown; onApply: (value: unknown) => void }) {
  const [text, setText] = useState(String(value ?? ''));
  useEffect(() => setText(String(value ?? '')), [value]);

  return (
    <TextInput
      value={text}
      onChangeText={setText}
      onEndEditing={() => onApply(text)}
      style={textInputStyle}
      placeholderTextColor={palette.textDim}
      autoCapitalize="none"
      autoCorrect={false}
    />
  );
}

const textInputStyle = {
  minHeight: 44,
  borderWidth: 1,
  borderColor: palette.border,
  borderRadius: 10,
  paddingHorizontal: 12,
  color: palette.text
};

import { useState } from 'react';
import { Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { chainPlans, InstanceSnapshot, PermissionMode } from '../lib/api';
import { palette, shared } from '../lib/theme';
import { Banner, Button, Chip, ConfirmSheet, Row } from '../components/ui';
import { AGENT_LABEL, describeWhen, isValidWhen, PERMISSION_MODES, WhenPicker, WhenValue } from '../components/WhenPicker';

interface Props {
  snapshot: InstanceSnapshot;
  refresh: () => void;
  refreshing: boolean;
}

/** `MAX_CHAIN_DELAY_MINUTES` in `src/types.ts` — a day, the longest a "gap" means before it is a clock time. */
const MAX_GAP_MINUTES = 1440;
const FALLBACK_AGENTS = ['claude', 'opencode', 'codex'];

export default function ChainTab({ snapshot, refresh }: Props) {
  const { instance, plans, availableAgents } = snapshot;
  const [names, setNames] = useState<string[]>([]);
  const [gapText, setGapText] = useState('15');
  const [stopOnFailure, setStopOnFailure] = useState(true);
  const [when, setWhen] = useState<WhenValue>({ repeat: 'once', at: new Date().toISOString() });
  const [agent, setAgent] = useState('claude');
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('auto');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const gapMinutes = Number(gapText);
  const gapValid = Number.isInteger(gapMinutes) && gapMinutes >= 0 && gapMinutes <= MAX_GAP_MINUTES;
  const unique = new Set(names);
  const canCreate = unique.size >= 2 && gapValid && isValidWhen(when);
  const agentOptions = availableAgents && availableAgents.length ? availableAgents : FALLBACK_AGENTS;

  const rest = plans.filter((p) => !names.includes(p.name));

  function add(name: string) {
    setNames((prev) => (prev.includes(name) ? prev : [...prev, name]));
  }
  function remove(index: number) {
    setNames((prev) => prev.filter((_, i) => i !== index));
  }
  function moveUp(index: number) {
    if (index === 0) return;
    setNames((prev) => {
      const next = prev.slice();
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  }
  function moveDown(index: number) {
    setNames((prev) => {
      if (index >= prev.length - 1) return prev;
      const next = prev.slice();
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  }

  function titleOf(name: string): string {
    return plans.find((p) => p.name === name)?.title ?? name;
  }

  async function handleCreate() {
    setConfirming(false);
    setError(undefined);
    try {
      await chainPlans(instance, {
        names,
        startIso: when.repeat === 'once' ? when.at : new Date().toISOString(),
        gapMinutes,
        stopOnFailure,
        agent: agent as 'claude' | 'opencode' | 'codex',
        model: model.trim() || undefined,
        permissionMode
      });
      setNames([]);
      setGapText('15');
      setStopOnFailure(true);
      setWhen({ repeat: 'once', at: new Date().toISOString() });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create that chain.');
    }
  }

  return (
    <ScrollView style={{ flex: 1 }}>
      {error ? <Banner kind="error" message={error} /> : null}

      <Text style={shared.heading}>Library</Text>
      <View style={{ marginTop: 8 }}>
        {rest.length === 0 ? (
          <Text style={{ color: palette.textDim }}>Every plan is already in the chain.</Text>
        ) : (
          rest.map((p) => (
            <Pressable key={p.name} onPress={() => add(p.name)} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
              <View style={[shared.card, { marginBottom: 8 }]}>
                <Text style={{ color: palette.text }}>{p.title}</Text>
              </View>
            </Pressable>
          ))
        )}
      </View>

      <Text style={[shared.heading, { marginTop: 20 }]}>Chain</Text>
      <View style={{ marginTop: 8 }}>
        {names.length === 0 ? (
          <Text style={{ color: palette.textDim }}>Tap a plan above to add it here.</Text>
        ) : (
          names.map((name, i) => (
            <View key={`${name}-${i}`} style={[shared.card, { marginBottom: 8 }]}>
              <Row>
                <Text style={{ color: palette.text, flexShrink: 1 }}>
                  {i + 1}. {titleOf(name)}
                </Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Button label="↑" variant="ghost" onPress={() => moveUp(i)} disabled={i === 0} />
                  <Button label="↓" variant="ghost" onPress={() => moveDown(i)} disabled={i === names.length - 1} />
                  <Button label="✕" variant="danger" onPress={() => remove(i)} />
                </View>
              </Row>
            </View>
          ))
        )}
      </View>

      <Text style={[shared.heading, { marginTop: 20 }]}>Timing</Text>
      <WhenPicker value={when} onChange={setWhen} allowRecurrence={false} />

      <Text style={fieldLabel}>Gap between plans (minutes)</Text>
      <TextInput
        value={gapText}
        onChangeText={setGapText}
        keyboardType="number-pad"
        placeholderTextColor={palette.textDim}
        style={[textInputStyle, !gapValid && { borderColor: palette.danger }]}
      />

      <Row style={{ marginTop: 14 }}>
        <Text style={{ color: palette.text }}>Stop the chain if a plan fails</Text>
        <Switch value={stopOnFailure} onValueChange={setStopOnFailure} />
      </Row>

      <Text style={fieldLabel}>Agent</Text>
      <View style={chipsRow}>
        {agentOptions.map((a) => (
          <Chip key={a} label={AGENT_LABEL[a] ?? a} selected={agent === a} onPress={() => setAgent(a)} />
        ))}
      </View>

      <Text style={fieldLabel}>Model</Text>
      <TextInput
        value={model}
        onChangeText={setModel}
        placeholder="(account default)"
        placeholderTextColor={palette.textDim}
        autoCapitalize="none"
        autoCorrect={false}
        style={textInputStyle}
      />

      <Text style={fieldLabel}>Permission mode</Text>
      <View style={chipsRow}>
        {PERMISSION_MODES.map((m) => (
          <Chip key={m} label={m} selected={permissionMode === m} onPress={() => setPermissionMode(m)} />
        ))}
      </View>

      <Button
        label="Create chain"
        onPress={() => setConfirming(true)}
        disabled={!canCreate}
        style={{ marginTop: 20, marginBottom: 24 }}
      />

      <ConfirmSheet
        visible={confirming}
        title="Create chain"
        message={`${unique.size} plans, ${gapMinutes} min apart, starting ${describeWhen(when)}.`}
        confirmLabel="Create"
        onCancel={() => setConfirming(false)}
        onConfirm={handleCreate}
      />
    </ScrollView>
  );
}

const fieldLabel = { color: palette.textDim, fontSize: 12, marginTop: 14, marginBottom: 6 };
const chipsRow = { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 8 };
const textInputStyle = {
  minHeight: 44,
  borderWidth: 1,
  borderColor: palette.border,
  borderRadius: 10,
  paddingHorizontal: 12,
  color: palette.text
};

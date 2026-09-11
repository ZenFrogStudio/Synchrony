import { useState } from 'react';
import { ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { InstanceSnapshot, PermissionMode, runNow, Series, unscheduleSeries, updateSeries } from '../lib/api';
import { relativeTime } from '../lib/relativeTime';
import { palette, shared } from '../lib/theme';
import { Banner, Button, Chip, ConfirmSheet, Row, Sheet, sheetStyles } from '../components/ui';
import { AGENT_LABEL, describeWhen, fromSeries, isValidWhen, PERMISSION_MODES, toRecurrencePatch, WhenPicker, WhenValue } from '../components/WhenPicker';

interface Props {
  snapshot: InstanceSnapshot;
  refresh: () => void;
  refreshing: boolean;
}

interface EditState {
  id: string;
  when: WhenValue;
  agent: string;
  model: string;
  permissionMode: PermissionMode;
  maxRetriesText: string;
}

const FALLBACK_AGENTS = ['claude', 'opencode', 'codex'];

export default function ScheduleTab({ snapshot, refresh }: Props) {
  const { instance, series, plans, availableAgents } = snapshot;
  const [error, setError] = useState<string | undefined>(undefined);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [confirm, setConfirm] = useState<{ type: 'runNow' | 'unschedule'; target: Series } | null>(null);

  function planTitle(s: Series): string {
    const plan = plans.find((p) => p.name === s.plan);
    return plan ? plan.title : s.plan.replace(/\.md$/i, '');
  }

  function chainLabel(s: Series): string | null {
    if (!s.runsAfter) return null;
    const target = series.find((x) => x.id === s.runsAfter!.seriesId);
    return `After ${target ? planTitle(target) : 'a plan that is gone'}`;
  }

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    setError(undefined);
    try {
      const out = await action();
      refresh();
      return out;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      return undefined;
    }
  }

  function openEdit(s: Series) {
    setEdit({
      id: s.id,
      when: fromSeries(s),
      agent: s.engine || 'claude',
      model: s.model === '(account default)' ? '' : s.model,
      permissionMode: s.permissionMode || 'auto',
      maxRetriesText: String(s.maxRetries)
    });
  }

  async function handleApply() {
    if (!edit) return;
    const maxRetries = Number(edit.maxRetriesText);
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
      setError('Max retries must be a whole number from 0 to 10.');
      return;
    }
    const target = edit.id;
    const patch = {
      ...toRecurrencePatch(edit.when),
      agent: edit.agent,
      model: edit.model.trim() || undefined,
      permissionMode: edit.permissionMode,
      maxRetries
    };
    const out = await run(() => updateSeries(instance, target, patch));
    if (out) setEdit(null);
  }

  async function handleConfirm() {
    if (!confirm) return;
    const target = confirm;
    setConfirm(null);
    if (target.type === 'runNow') await run(() => runNow(instance, target.target.id));
    else await run(() => unscheduleSeries(instance, target.target.id));
  }

  const agentOptions = availableAgents && availableAgents.length ? availableAgents : FALLBACK_AGENTS;

  return (
    <View style={{ flex: 1 }}>
      {error ? <Banner kind="error" message={error} /> : null}

      <ScrollView style={{ flex: 1 }}>
        {series.length === 0 ? <Text style={{ color: palette.textDim, marginTop: 8 }}>Nothing scheduled yet.</Text> : null}
        {series.map((s) => (
          <View key={s.id} style={[shared.card, { marginBottom: 10 }]}>
            <Row>
              <Text style={{ color: palette.text, fontWeight: '600', flexShrink: 1 }}>{planTitle(s)}</Text>
              <Switch
                value={s.enabled}
                onValueChange={(v) => {
                  void run(() => updateSeries(instance, s.id, { enabled: v }));
                }}
              />
            </Row>
            <Text style={{ color: palette.textDim, fontSize: 12, marginTop: 4 }}>
              {relativeTime(s.nextRunAt)} · {describeWhen(fromSeries(s))}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              <Chip label={AGENT_LABEL[s.engine] ?? s.engine} />
              <Chip label={s.model} />
              {chainLabel(s) ? <Chip label={chainLabel(s)!} color={palette.accent} /> : null}
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              <Button label="Edit" variant="ghost" onPress={() => openEdit(s)} />
              <Button label="Run now" variant="ghost" onPress={() => setConfirm({ type: 'runNow', target: s })} />
              <Button label="Unschedule" variant="danger" onPress={() => setConfirm({ type: 'unschedule', target: s })} />
            </View>
          </View>
        ))}
      </ScrollView>

      <ConfirmSheet
        visible={!!confirm}
        title={confirm?.type === 'runNow' ? 'Run now' : 'Unschedule'}
        message={
          confirm?.type === 'runNow'
            ? 'Runs via the desktop scheduler within ~30s.'
            : 'Removes this series and its run history.'
        }
        confirmLabel={confirm?.type === 'runNow' ? 'Run now' : 'Unschedule'}
        destructive={confirm?.type === 'unschedule'}
        onCancel={() => setConfirm(null)}
        onConfirm={handleConfirm}
      />

      <Sheet visible={!!edit} onClose={() => setEdit(null)}>
        <ScrollView style={{ maxHeight: 480 }}>
          <Text style={sheetStyles.title}>Edit schedule</Text>
          {edit ? (
            <>
              <WhenPicker value={edit.when} onChange={(when) => setEdit((prev) => (prev ? { ...prev, when } : prev))} />

              <Text style={fieldLabel}>Agent</Text>
              <View style={chipsRow}>
                {agentOptions.map((a) => (
                  <Chip
                    key={a}
                    label={AGENT_LABEL[a] ?? a}
                    selected={edit.agent === a}
                    onPress={() => setEdit((prev) => (prev ? { ...prev, agent: a } : prev))}
                  />
                ))}
              </View>

              <Text style={fieldLabel}>Model</Text>
              <TextInput
                value={edit.model}
                onChangeText={(text) => setEdit((prev) => (prev ? { ...prev, model: text } : prev))}
                placeholder="(account default)"
                placeholderTextColor={palette.textDim}
                style={textInputStyle}
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Text style={fieldLabel}>Permission mode</Text>
              <View style={chipsRow}>
                {PERMISSION_MODES.map((m) => (
                  <Chip
                    key={m}
                    label={m}
                    selected={edit.permissionMode === m}
                    onPress={() => setEdit((prev) => (prev ? { ...prev, permissionMode: m } : prev))}
                  />
                ))}
              </View>

              <Text style={fieldLabel}>Max retries</Text>
              <TextInput
                value={edit.maxRetriesText}
                onChangeText={(text) => setEdit((prev) => (prev ? { ...prev, maxRetriesText: text } : prev))}
                keyboardType="number-pad"
                placeholderTextColor={palette.textDim}
                style={textInputStyle}
              />

              <Row style={{ marginTop: 20, gap: 12 }}>
                <Button label="Cancel" variant="ghost" onPress={() => setEdit(null)} style={{ flex: 1 }} />
                <Button label="Apply" onPress={handleApply} disabled={!isValidWhen(edit.when)} style={{ flex: 1 }} />
              </Row>
            </>
          ) : null}
        </ScrollView>
      </Sheet>
    </View>
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

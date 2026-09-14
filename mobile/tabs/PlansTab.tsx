import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import {
  appendToChain,
  archivePlan,
  createPlan,
  InstanceSnapshot,
  PlanFile,
  readPlan,
  renamePlan,
  savePlan,
  schedulePlan,
  unscheduleSeries
} from '../lib/api';
import { relativeTime } from '../lib/relativeTime';
import { palette, shared } from '../lib/theme';
import { Banner, Button, Chip, ConfirmSheet, PromptModal, Row, Sheet, sheetStyles } from '../components/ui';
import { describeWhen, fromSeries, isValidWhen, toScheduleArgs, WhenPicker, WhenValue } from '../components/WhenPicker';

interface Props {
  snapshot: InstanceSnapshot;
  refresh: () => void;
  refreshing: boolean;
}

export default function PlansTab({ snapshot, refresh }: Props) {
  const { instance, plans, series } = snapshot;
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [openPlan, setOpenPlan] = useState<PlanFile | null>(null);

  async function handleCreate() {
    const title = newTitle.trim();
    if (!title) return;
    setCreating(false);
    setNewTitle('');
    try {
      await createPlan(instance, title);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create that plan.');
    }
  }

  if (openPlan) {
    return (
      <PlanEditor
        instance={instance}
        plan={openPlan}
        series={series.find((s) => s.plan === openPlan.name)}
        plans={plans}
        allSeries={series}
        onClose={() => setOpenPlan(null)}
        onChanged={refresh}
      />
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {error ? <Banner kind="error" message={error} /> : null}
      <Row>
        <Text style={shared.heading}>Plans</Text>
        <Button label="New" onPress={() => setCreating(true)} />
      </Row>

      <ScrollView style={{ marginTop: 12 }}>
        {plans.length === 0 ? <Text style={{ color: palette.textDim, marginTop: 8 }}>No plans yet.</Text> : null}
        {plans.map((plan) => {
          const scheduled = series.some((s) => s.plan === plan.name);
          return (
            <Pressable key={plan.name} onPress={() => setOpenPlan(plan)} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
              <View style={[shared.card, { marginBottom: 10 }]}>
                <Row>
                  <Text style={{ color: palette.text, fontWeight: '600', flexShrink: 1 }}>{plan.title}</Text>
                  {scheduled ? <Chip label="Scheduled" color={palette.accent} /> : null}
                </Row>
                <Text style={{ color: palette.textDim, fontSize: 12, marginTop: 4 }}>Modified {relativeTime(plan.modified)}</Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>

      <PromptModal
        visible={creating}
        title="New plan"
        value={newTitle}
        onChangeValue={setNewTitle}
        onCancel={() => setCreating(false)}
        onSave={handleCreate}
        saveLabel="Create"
      />
    </View>
  );
}

function PlanEditor({
  instance,
  plan,
  series,
  plans,
  allSeries,
  onClose,
  onChanged
}: {
  instance: string;
  plan: PlanFile;
  series?: InstanceSnapshot['series'][number];
  plans: PlanFile[];
  allSeries: InstanceSnapshot['series'];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [text, setText] = useState<string | undefined>(undefined);
  const [original, setOriginal] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [confirmBack, setConfirmBack] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(plan.title);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmUnschedule, setConfirmUnschedule] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [when, setWhen] = useState<WhenValue>({ repeat: 'once', at: new Date().toISOString() });
  const [appending, setAppending] = useState(false);

  // In a chain either way: a follower carries `runsAfter`, and a head is only
  // known by something waiting on it. The hub walks to the tail from either.
  const inChain = (id?: string) =>
    !!id && allSeries.some((s) => (s.id === id && s.runsAfter) || s.runsAfter?.seriesId === id);
  const chained = !!series && inChain(series.id);
  // Plans that could go on the end: anything not already in a chain — the same
  // rule the hub applies before it writes.
  const addable = plans.filter((p) => {
    const ps = allSeries.find((s) => s.plan === p.name);
    return p.name !== plan.name && (!ps || !inChain(ps.id));
  });

  useEffect(() => {
    let cancelled = false;
    readPlan(instance, plan.name)
      .then((t) => {
        if (!cancelled) {
          setText(t);
          setOriginal(t);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load that plan.');
      });
    return () => {
      cancelled = true;
    };
  }, [instance, plan.name]);

  const dirty = text !== undefined && text !== original;

  function requestClose() {
    if (dirty) setConfirmBack(true);
    else onClose();
  }

  async function handleSave() {
    if (text === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      await savePlan(instance, plan.name, text);
      setOriginal(text);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that plan.');
    } finally {
      setSaving(false);
    }
  }

  async function handleRename() {
    const title = renameValue.trim();
    setRenaming(false);
    if (!title) return;
    try {
      await renamePlan(instance, plan.name, title);
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename that plan.');
    }
  }

  async function handleArchive() {
    setConfirmArchive(false);
    try {
      await archivePlan(instance, plan.name);
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not archive that plan.');
    }
  }

  async function handleSchedule() {
    try {
      await schedulePlan(instance, { name: plan.name, ...toScheduleArgs(when) });
      setScheduling(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not schedule that plan.');
    }
  }

  async function handleUnschedule() {
    if (!series) return;
    setConfirmUnschedule(false);
    try {
      await unscheduleSeries(instance, series.id);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unschedule that plan.');
    }
  }

  async function handleAppend(name: string) {
    if (!series) return;
    setAppending(false);
    try {
      await appendToChain(instance, series.id, name);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that plan to the chain.');
    }
  }

  return (
    <View style={shared.screen}>
      <Row>
        <Pressable onPress={requestClose} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
          <Text style={{ color: palette.accent, fontSize: 15 }}>{'< Plans'}</Text>
        </Pressable>
        <Button label="Save" onPress={handleSave} disabled={!dirty || saving} />
      </Row>

      <Text style={[shared.heading, { marginTop: 8 }]}>{plan.title}</Text>
      {series ? (
        <View style={{ marginTop: 8, alignSelf: 'flex-start' }}>
          <Chip label={`Scheduled · ${describeWhen(fromSeries(series))}`} color={palette.accent} />
        </View>
      ) : null}
      {error ? (
        <View style={{ marginTop: 8 }}>
          <Banner kind="error" message={error} />
        </View>
      ) : null}

      <ScrollView style={{ flex: 1, marginTop: 12 }}>
        {text === undefined ? (
          <Text style={{ color: palette.textDim }}>Loading…</Text>
        ) : (
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            textAlignVertical="top"
            autoCapitalize="none"
            autoCorrect={false}
            style={{
              minHeight: 300,
              color: palette.text,
              fontFamily: 'monospace',
              fontSize: 13,
              lineHeight: 18
            }}
          />
        )}
      </ScrollView>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <Button label="Rename" variant="ghost" onPress={() => setRenaming(true)} />
        {series ? (
          <Button label="Unschedule" variant="danger" onPress={() => setConfirmUnschedule(true)} />
        ) : (
          <Button label="Schedule" variant="ghost" onPress={() => setScheduling(true)} />
        )}
        {chained ? <Button label="Add to chain" variant="ghost" onPress={() => setAppending(true)} /> : null}
        <Button label="Archive" variant="danger" onPress={() => setConfirmArchive(true)} />
      </View>

      <PromptModal
        visible={renaming}
        title="Rename plan"
        value={renameValue}
        onChangeValue={setRenameValue}
        onCancel={() => setRenaming(false)}
        onSave={handleRename}
        saveLabel="Rename"
      />

      <ConfirmSheet
        visible={confirmArchive}
        title="Archive plan"
        message="Moves this plan out of the library into its archive."
        confirmLabel="Archive"
        destructive
        onCancel={() => setConfirmArchive(false)}
        onConfirm={handleArchive}
      />

      <ConfirmSheet
        visible={confirmUnschedule}
        title="Unschedule"
        message="Removes this series and its run history."
        confirmLabel="Unschedule"
        destructive
        onCancel={() => setConfirmUnschedule(false)}
        onConfirm={handleUnschedule}
      />

      <ConfirmSheet
        visible={confirmBack}
        title="Discard changes?"
        message="This plan has unsaved edits that will be lost."
        confirmLabel="Discard"
        destructive
        onCancel={() => setConfirmBack(false)}
        onConfirm={() => {
          setConfirmBack(false);
          onClose();
        }}
      />

      <Sheet visible={scheduling} onClose={() => setScheduling(false)}>
        <Text style={sheetStyles.title}>Schedule</Text>
        <WhenPicker value={when} onChange={setWhen} />
        <Row style={{ marginTop: 20, gap: 12 }}>
          <Button label="Cancel" variant="ghost" onPress={() => setScheduling(false)} style={{ flex: 1 }} />
          <Button label="Schedule" onPress={handleSchedule} disabled={!isValidWhen(when)} style={{ flex: 1 }} />
        </Row>
      </Sheet>

      <Sheet visible={appending} onClose={() => setAppending(false)}>
        <Text style={sheetStyles.title}>Add to chain</Text>
        <Text style={{ color: palette.textDim, marginTop: 4 }}>
          Runs after the last plan in the chain, with the same gap and failure rule.
        </Text>
        <ScrollView style={{ maxHeight: 320, marginTop: 12 }}>
          {addable.length === 0 ? (
            <Text style={{ color: palette.textDim }}>Every plan is already in a chain.</Text>
          ) : (
            addable.map((p) => (
              <Pressable key={p.name} onPress={() => handleAppend(p.name)} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
                <View style={[shared.card, { marginBottom: 8 }]}>
                  <Text style={{ color: palette.text }}>{p.title}</Text>
                </View>
              </Pressable>
            ))
          )}
        </ScrollView>
        <Row style={{ marginTop: 12 }}>
          <Button label="Cancel" variant="ghost" onPress={() => setAppending(false)} style={{ flex: 1 }} />
        </Row>
      </Sheet>
    </View>
  );
}

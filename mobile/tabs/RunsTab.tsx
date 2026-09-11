import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { ActivityEntry, cancelRun, dismissRun, InstanceSnapshot, rerunRun, Run, runNow, RunStatus } from '../lib/api';
import { relativeTime } from '../lib/relativeTime';
import { palette, shared } from '../lib/theme';
import { Banner, Button, Chip, ConfirmSheet, Row } from '../components/ui';
import TranscriptView from '../components/TranscriptView';

interface Props {
  snapshot: InstanceSnapshot;
  refresh: () => void;
  refreshing: boolean;
}

type Filter = 'all' | 'upcoming' | 'attention' | 'completed';
const FILTERS: Filter[] = ['all', 'upcoming', 'attention', 'completed'];
const FILTER_LABEL: Record<Filter, string> = { all: 'All', upcoming: 'Upcoming', attention: 'Attention', completed: 'Completed' };
const FINISHED: RunStatus[] = ['completed', 'failed', 'cancelled'];

/** A run you would want to be told about — mirrors the desktop Manager's rule. */
const needsAttention = (run: Run) => run.status === 'failed' || run.status === 'missed' || !!run.denials;

function statusColor(status: RunStatus): string {
  switch (status) {
    case 'running':
      return palette.status.running;
    case 'completed':
      return palette.status.success;
    case 'failed':
      return palette.status.failure;
    case 'missed':
      return palette.status.missed;
    default:
      return palette.status.pending;
  }
}

type Action = 'cancel' | 'dismiss' | 'rerun' | 'runNow' | 'transcript';
interface Confirm {
  type: Exclude<Action, 'transcript'>;
  run: Run;
}

export default function RunsTab({ snapshot, refresh }: Props) {
  const { instance, activity, runs, costLast7Days } = snapshot;
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState<string | undefined>(undefined);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [transcriptRunId, setTranscriptRunId] = useState<string | null>(null);
  const [pendingCancel, setPendingCancel] = useState<Set<string>>(new Set());

  const runById = new Map(runs.map((r) => [r.id, r]));

  useEffect(() => {
    setPendingCancel((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      for (const id of prev) {
        const r = runById.get(id);
        if (!r || r.status !== 'running') next.delete(id);
      }
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs]);

  if (transcriptRunId) {
    return <TranscriptView instance={instance} runId={transcriptRunId} onClose={() => setTranscriptRunId(null)} />;
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

  async function handleAction(action: Action, target: Run) {
    if (action === 'transcript') {
      setTranscriptRunId(target.id);
      return;
    }
    setConfirm({ type: action, run: target });
  }

  async function handleConfirm() {
    if (!confirm) return;
    const { type, run: target } = confirm;
    setConfirm(null);
    if (type === 'cancel') {
      const note = await run(() => cancelRun(instance, target.id));
      if (note && /no window/i.test(note)) {
        setPendingCancel((prev) => new Set(prev).add(target.id));
      }
    } else if (type === 'dismiss') {
      await run(() => dismissRun(instance, target.id));
    } else if (type === 'rerun') {
      await run(() => rerunRun(instance, target.id));
    } else if (type === 'runNow') {
      await run(() => runNow(instance, target.seriesId, target.id));
    }
  }

  const upcoming = filter === 'all' || filter === 'upcoming' ? activity.upcoming : [];
  const recent = (filter === 'all' || filter === 'completed' || filter === 'attention' ? activity.recent : []).filter(
    (entry) => {
      const r = entry.runId ? runById.get(entry.runId) : undefined;
      if (!r) return false;
      if (filter === 'completed') return r.status === 'completed';
      if (filter === 'attention') return needsAttention(r);
      return true;
    }
  );

  return (
    <View style={{ flex: 1 }}>
      {error ? <Banner kind="error" message={error} /> : null}

      <Row>
        <Text style={{ color: palette.textDim }}>Last 7 days</Text>
        <Text style={{ color: palette.text, fontWeight: '600' }}>${costLast7Days.toFixed(2)}</Text>
      </Row>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {FILTERS.map((f) => (
            <Chip key={f} label={FILTER_LABEL[f]} selected={filter === f} onPress={() => setFilter(f)} />
          ))}
        </View>
      </ScrollView>

      <ScrollView style={{ flex: 1, marginTop: 12 }}>
        {!upcoming.length && !recent.length ? (
          <Text style={{ color: palette.textDim, marginTop: 8 }}>
            {filter === 'all' ? 'Nothing scheduled or run yet.' : 'Nothing matches this filter.'}
          </Text>
        ) : null}

        {upcoming.length ? <Text style={sectionLabel}>Upcoming</Text> : null}
        {upcoming.map((entry) => (
          <ActivityRow
            key={`${entry.seriesId}-${entry.at}`}
            entry={entry}
            run={entry.runId ? runById.get(entry.runId) : undefined}
            pending={entry.runId ? pendingCancel.has(entry.runId) : false}
            onAction={handleAction}
          />
        ))}

        {recent.length ? <Text style={sectionLabel}>Recent</Text> : null}
        {recent.map((entry) => (
          <ActivityRow
            key={entry.runId}
            entry={entry}
            run={entry.runId ? runById.get(entry.runId) : undefined}
            pending={entry.runId ? pendingCancel.has(entry.runId) : false}
            onAction={handleAction}
          />
        ))}
      </ScrollView>

      <ConfirmSheet
        visible={!!confirm}
        title={confirmTitle(confirm)}
        message={confirmMessage(confirm)}
        confirmLabel={confirmLabel(confirm)}
        destructive={confirm?.type === 'cancel'}
        onCancel={() => setConfirm(null)}
        onConfirm={handleConfirm}
      />
    </View>
  );
}

function ActivityRow({
  entry,
  run,
  pending,
  onAction
}: {
  entry: ActivityEntry;
  run?: Run;
  pending: boolean;
  onAction: (action: Action, run: Run) => void;
}) {
  if (!run) {
    return (
      <View style={[shared.card, { marginBottom: 10 }]}>
        <Text style={{ color: palette.text, fontWeight: '600' }}>{entry.planTitle}</Text>
        <Text style={{ color: palette.textDim, fontSize: 12, marginTop: 4 }}>{relativeTime(entry.at)}</Text>
      </View>
    );
  }

  const color = statusColor(run.status);

  return (
    <View style={[shared.card, { marginBottom: 10, borderColor: color }]}>
      <Row>
        <Text style={{ color: palette.text, fontWeight: '600', flexShrink: 1 }}>{entry.planTitle}</Text>
        <Chip label={run.status} color={color} />
      </Row>
      <Row style={{ marginTop: 6 }}>
        <Text style={{ color: palette.textDim, fontSize: 12 }}>
          {relativeTime(run.scheduledAt)}
          {run.attempt > 1 ? ` · retry ${run.attempt - 1}` : ''}
        </Text>
        {run.costUsd ? <Text style={{ color: palette.textDim, fontSize: 12 }}>${run.costUsd.toFixed(2)}</Text> : null}
      </Row>

      {run.status === 'failed' && run.lastError ? (
        <Text style={{ color: palette.status.failure, fontSize: 12, marginTop: 6 }} numberOfLines={3}>
          {run.lastError}
        </Text>
      ) : null}

      {pending ? (
        <View style={{ marginTop: 8, alignSelf: 'flex-start' }}>
          <Chip label="Cancel requested — pending" color={palette.status.pending} />
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
        {run.status === 'running' && !pending ? (
          <Button label="Cancel" variant="danger" onPress={() => onAction('cancel', run)} />
        ) : null}
        {run.status === 'missed' ? (
          <>
            <Button label="Run now" variant="ghost" onPress={() => onAction('runNow', run)} />
            <Button label="Dismiss" variant="ghost" onPress={() => onAction('dismiss', run)} />
          </>
        ) : null}
        {run.status === 'pending' ? <Button label="Dismiss" variant="ghost" onPress={() => onAction('dismiss', run)} /> : null}
        {FINISHED.includes(run.status) ? (
          <>
            <Button label="Rerun" variant="ghost" onPress={() => onAction('rerun', run)} />
            <Button label="Dismiss" variant="ghost" onPress={() => onAction('dismiss', run)} />
          </>
        ) : null}
        {run.hasTranscript ? <Button label="Transcript" variant="ghost" onPress={() => onAction('transcript', run)} /> : null}
      </View>
    </View>
  );
}

function confirmTitle(c: Confirm | null): string {
  if (!c) return '';
  return { cancel: 'Cancel run', dismiss: 'Dismiss run', rerun: 'Rerun plan', runNow: 'Run now' }[c.type];
}

function confirmMessage(c: Confirm | null): string {
  if (!c) return '';
  if (c.type === 'cancel') return 'Asks the desktop to stop this run. It may take a few seconds to confirm.';
  if (c.type === 'dismiss') return 'Removes this run from the history.';
  if (c.type === 'rerun') return 'Reruns the plan as it stands now.';
  return 'Runs via the desktop scheduler within ~30s.';
}

function confirmLabel(c: Confirm | null): string {
  if (!c) return 'Confirm';
  return { cancel: 'Cancel run', dismiss: 'Dismiss', rerun: 'Rerun', runNow: 'Run now' }[c.type];
}

const sectionLabel = { color: palette.textDim, fontSize: 12, fontWeight: '700' as const, marginTop: 12, marginBottom: 6 };

import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { InstanceSummary, listInstances } from '../lib/api';
import { usePoll } from '../lib/poll';
import { Route } from '../lib/routes';
import { forgetPairing, getClient } from '../lib/session';
import { palette, shared } from '../lib/theme';
import { Banner } from '../components/ui';

interface Props {
  navigate: (route: Route) => void;
}

const POLL_MS = 10_000;

export default function Instances({ navigate }: Props) {
  const { data, error, refreshing, refresh } = usePoll(() => listInstances(), POLL_MS);
  const instances = data?.instances ?? [];
  const host = getClient()?.host ?? '';

  return (
    <View style={shared.screen}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View>
          <Text style={shared.heading}>Instances</Text>
          {host ? <Text style={{ color: palette.textDim, marginTop: 2 }}>{host}</Text> : null}
        </View>
        <Pressable onPress={() => forgetPairing()} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
          <Text style={{ color: palette.accent, fontWeight: '600' }}>Re-pair</Text>
        </Pressable>
      </View>

      {error ? (
        <View style={{ marginTop: 16 }}>
          <Banner kind="error" message={error} actionLabel="Re-pair" onAction={() => forgetPairing()} />
        </View>
      ) : null}

      <FlatList
        style={{ marginTop: 16 }}
        data={instances}
        keyExtractor={(item) => item.instance}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={palette.text} />}
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        ListEmptyComponent={
          data ? <Text style={{ color: palette.textDim, marginTop: 8 }}>No instances yet.</Text> : null
        }
        renderItem={({ item }) => (
          <InstanceRow item={item} onPress={() => navigate({ screen: 'instance', name: item.instance, tab: 'tasks' })} />
        )}
      />
    </View>
  );
}

function InstanceRow({ item, onPress }: { item: InstanceSummary; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [shared.card, { opacity: pressed ? 0.7 : 1 }]}>
      <View style={shared.row}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {item.live ? <View style={rowDotStyle} /> : null}
          <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600' }}>{item.instance}</Text>
        </View>
        <Text style={{ color: palette.textDim, fontSize: 13 }}>
          {item.tasks} task{item.tasks === 1 ? '' : 's'}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
        {item.running ? <ActivityIndicator size="small" color={palette.status.running} /> : null}
        <Text style={{ color: statusColor(item) }}>{statusText(item)}</Text>
      </View>
    </Pressable>
  );
}

const rowDotStyle = {
  width: 8,
  height: 8,
  borderRadius: 4,
  backgroundColor: palette.status.success
};

/** Mirrors `src/status.ts`: running beats missed beats next-run, else idle. */
function statusText(item: InstanceSummary): string {
  if (item.running) return `Running: ${item.running.plan}`;
  if (item.missedRuns > 0) return `${item.missedRuns} missed run${item.missedRuns > 1 ? 's' : ''}`;
  if (item.next) {
    const when = new Date(item.next.nextRunAt);
    return `Next run ${when.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  }
  return 'No scheduled tasks';
}

function statusColor(item: InstanceSummary): string {
  if (item.running) return palette.status.running;
  if (item.missedRuns > 0) return palette.status.missed;
  return palette.textDim;
}

import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { readInstance } from '../lib/api';
import { usePoll } from '../lib/poll';
import { Route } from '../lib/routes';
import { palette, shared } from '../lib/theme';
import { Banner } from '../components/ui';
import TasksTab from '../tabs/TasksTab';

interface Props {
  name: string;
  initialTab: string;
  navigate: (route: Route) => void;
}

const POLL_MS = 5_000;
const TABS = ['tasks', 'plans', 'schedule', 'runs', 'chain', 'settings'] as const;
type Tab = (typeof TABS)[number];

const TAB_LABEL: Record<Tab, string> = {
  tasks: 'Tasks',
  plans: 'Plans',
  schedule: 'Schedule',
  runs: 'Runs',
  chain: 'Chain',
  settings: 'Settings'
};

export default function Instance({ name, initialTab, navigate }: Props) {
  const [tab, setTab] = useState<Tab>(TABS.includes(initialTab as Tab) ? (initialTab as Tab) : 'tasks');
  const { data, error, refreshing, refresh } = usePoll(() => readInstance(name), POLL_MS);

  return (
    <View style={shared.screen}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Pressable onPress={() => navigate({ screen: 'instances' })} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
          <Text style={{ color: palette.accent, fontSize: 15 }}>{'< Instances'}</Text>
        </Pressable>
      </View>
      <Text style={[shared.heading, { marginTop: 8 }]}>{name}</Text>

      {error ? (
        <View style={{ marginTop: 12 }}>
          <Banner kind="error" message={error} />
        </View>
      ) : null}

      {data && data.windows.length === 0 ? (
        <View style={{ marginTop: 12 }}>
          <Banner
            kind="info"
            message="No editor window open — runs, plan generation, cancel and settings need one; other changes queue safely."
          />
        </View>
      ) : null}

      <View style={{ flex: 1, marginTop: 12 }}>
        {!data ? (
          <Text style={{ color: palette.textDim }}>Loading…</Text>
        ) : tab === 'tasks' ? (
          <TasksTab snapshot={data} refresh={refresh} refreshing={refreshing} />
        ) : (
          <StubPanel label={TAB_LABEL[tab]} />
        )}
      </View>

      <View style={styles.tabBar}>
        {TABS.map((t) => (
          <Pressable
            key={t}
            onPress={() => setTab(t)}
            style={({ pressed }) => [styles.tabItem, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Text style={{ color: tab === t ? palette.accent : palette.textDim, fontSize: 12, fontWeight: tab === t ? '700' : '400' }}>
              {TAB_LABEL[t]}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function StubPanel({ label }: { label: string }) {
  return (
    <ScrollView contentContainerStyle={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: palette.textDim }}>{label} coming in a later stage.</Text>
    </ScrollView>
  );
}

const styles = {
  tabBar: {
    flexDirection: 'row' as const,
    borderTopWidth: 1,
    borderTopColor: palette.border,
    paddingTop: 10,
    marginTop: 10
  },
  tabItem: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center' as const,
    justifyContent: 'center' as const
  }
};

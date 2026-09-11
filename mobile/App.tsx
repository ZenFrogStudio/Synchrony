import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { McpClient } from './lib/mcp';
import { Route } from './lib/routes';
import { setClient, setNavigateHome, STORAGE_KEY } from './lib/session';
import { palette, shared } from './lib/theme';
import Pair from './screens/Pair';

export default function App() {
  const [route, setRoute] = useState<Route | undefined>(undefined);

  useEffect(() => {
    setNavigateHome(() => setRoute({ screen: 'pair' }));
    AsyncStorage.getItem(STORAGE_KEY).then((stored) => {
      if (stored) {
        setClient(new McpClient(stored));
        setRoute({ screen: 'instances' });
      } else {
        setRoute({ screen: 'pair' });
      }
    });
  }, []);

  if (!route) {
    return <View style={shared.screen} />;
  }

  const navigate = (next: Route) => setRoute(next);

  return (
    <>
      <StatusBar style="light" />
      {route.screen === 'pair' && <Pair navigate={navigate} />}
      {route.screen === 'instances' && <InstancesStub />}
      {route.screen === 'instance' && <InstanceStub name={route.name} />}
    </>
  );
}

/** Filled in by the next stage. */
function InstancesStub() {
  return (
    <View style={shared.screen}>
      <Text style={shared.heading}>Instances</Text>
      <Text style={{ color: palette.textDim, marginTop: 8 }}>Coming in the next stage.</Text>
    </View>
  );
}

/** Filled in by the next stage. */
function InstanceStub({ name }: { name: string }) {
  return (
    <View style={shared.screen}>
      <Text style={shared.heading}>{name}</Text>
      <Text style={{ color: palette.textDim, marginTop: 8 }}>Coming in the next stage.</Text>
    </View>
  );
}

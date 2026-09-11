import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { McpClient } from './lib/mcp';
import { Route } from './lib/routes';
import { setClient, setNavigateHome, STORAGE_KEY } from './lib/session';
import { shared } from './lib/theme';
import Instance from './screens/Instance';
import Instances from './screens/Instances';
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
      {route.screen === 'instances' && <Instances navigate={navigate} />}
      {route.screen === 'instance' && (
        <Instance name={route.name} initialTab={route.tab} navigate={navigate} />
      )}
    </>
  );
}

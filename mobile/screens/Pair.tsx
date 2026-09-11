import AsyncStorage from '@react-native-async-storage/async-storage';
import { useState } from 'react';
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { checkHealth, McpClient, McpError } from '../lib/mcp';
import { Route } from '../lib/routes';
import { setClient, STORAGE_KEY } from '../lib/session';
import { palette, shared } from '../lib/theme';

interface Props {
  navigate: (route: Route) => void;
}

/** `https://<host>/<token>/mcp` — the shape `scripts/hub-up.ps1` prints. */
function parseConnectorUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'That does not look like a URL.' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'The connector URL must start with https://.' };
  }
  if (!/^\/[^/]+\/mcp\/?$/.test(parsed.pathname)) {
    return { ok: false, reason: 'The connector URL should look like https://<host>/<token>/mcp.' };
  }
  return { ok: true, url: parsed.toString() };
}

export default function Pair({ navigate }: Props) {
  const [pasted, setPasted] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const handleConnect = async () => {
    setError(undefined);
    const shape = parseConnectorUrl(pasted);
    if (!shape.ok) {
      setError(shape.reason);
      return;
    }

    setConnecting(true);
    try {
      await checkHealth(shape.url);
      const client = new McpClient(shape.url);
      await client.initialize();
      await AsyncStorage.setItem(STORAGE_KEY, shape.url);
      setClient(client);
      navigate({ screen: 'instances' });
    } catch (err) {
      setError(err instanceof McpError ? err.message : 'Something went wrong connecting.');
    } finally {
      setConnecting(false);
    }
  };

  return (
    <View style={shared.screen}>
      <Text style={shared.heading}>Pair with your desktop</Text>
      <Text style={{ color: palette.textDim, marginTop: 8, lineHeight: 20 }}>
        Run{' '}
        <Text style={{ fontFamily: 'monospace', color: palette.text }}>npm run hub:up</Text>
        {' '}on your desktop and paste (or scan) the printed URL. The URL changes every time the
        tunnel restarts.
      </Text>

      <TextInput
        value={pasted}
        onChangeText={setPasted}
        placeholder="https://xxxxx.trycloudflare.com/token/mcp"
        placeholderTextColor={palette.textDim}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        keyboardType="url"
        editable={!connecting}
        style={{
          marginTop: 20,
          borderWidth: 1,
          borderColor: palette.border,
          borderRadius: 10,
          color: palette.text,
          padding: 12,
          fontFamily: 'monospace'
        }}
      />

      {error ? (
        <Text style={{ color: palette.danger, marginTop: 12 }}>{error}</Text>
      ) : null}

      <TouchableOpacity
        onPress={handleConnect}
        disabled={connecting || !pasted.trim()}
        style={{
          marginTop: 20,
          backgroundColor: connecting || !pasted.trim() ? palette.surface : palette.accent,
          borderRadius: 10,
          paddingVertical: 14,
          alignItems: 'center'
        }}
      >
        {connecting ? (
          <ActivityIndicator color={palette.text} />
        ) : (
          <Text style={{ color: palette.text, fontWeight: '600' }}>Connect</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

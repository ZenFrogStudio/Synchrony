import AsyncStorage from '@react-native-async-storage/async-storage';
import { type BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import { useRef, useState } from 'react';
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { checkHealth, McpClient, McpError } from '../lib/mcp';
import { parseConnectorUrl } from '../lib/pairing';
import { Route } from '../lib/routes';
import { setClient, STORAGE_KEY } from '../lib/session';
import { palette, shared } from '../lib/theme';

interface Props {
  navigate: (route: Route) => void;
}

export default function Pair({ navigate }: Props) {
  const [pasted, setPasted] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  // `onBarcodeScanned` fires on every frame the code stays in view; only the
  // first hit per scan session may connect.
  const scanHandled = useRef(false);

  const connect = async (raw: string) => {
    setError(undefined);
    const shape = parseConnectorUrl(raw);
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

  const handleScan = async () => {
    setError(undefined);
    if (!permission?.granted) {
      const asked = await requestPermission();
      if (!asked.granted) {
        setError('Camera permission denied — paste the URL instead.');
        return;
      }
    }
    scanHandled.current = false;
    setScanning(true);
  };

  // The payload lands in the text box exactly as a paste would, so the user
  // can see (and fix) what was read. It is never logged — it carries the token.
  const handleBarcode = (result: BarcodeScanningResult) => {
    if (scanHandled.current) return;
    scanHandled.current = true;
    setScanning(false);
    setPasted(result.data);
    connect(result.data);
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
        onPress={() => connect(pasted)}
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

      <TouchableOpacity
        onPress={handleScan}
        disabled={connecting}
        style={{
          marginTop: 12,
          backgroundColor: palette.surface,
          borderWidth: 1,
          borderColor: palette.border,
          borderRadius: 10,
          paddingVertical: 14,
          alignItems: 'center'
        }}
      >
        <Text style={{ color: palette.text, fontWeight: '600' }}>Scan QR code</Text>
      </TouchableOpacity>

      {scanning ? (
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: palette.background
          }}
        >
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={handleBarcode}
          />
          <TouchableOpacity onPress={() => setScanning(false)} style={{ padding: 16, alignItems: 'center' }}>
            <Text style={{ color: palette.text, fontWeight: '600' }}>Cancel</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

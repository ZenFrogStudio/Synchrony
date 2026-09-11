import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { readLog, readTranscript } from '../lib/api';
import { palette, shared } from '../lib/theme';
import { Banner, Button } from './ui';

interface Props {
  instance: string;
  runId: string;
  onClose: () => void;
}

type Mode = 'transcript' | 'log';

/** No markdown-rendering dependency — plain monospace text is lean and enough. */
export default function TranscriptView({ instance, runId, onClose }: Props) {
  const [mode, setMode] = useState<Mode>('transcript');
  const [text, setText] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setText(undefined);
    setError(undefined);
    (mode === 'transcript' ? readTranscript(instance, runId) : readLog(instance, runId))
      .then((t) => {
        if (!cancelled) setText(t);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load that.');
      });
    return () => {
      cancelled = true;
    };
  }, [instance, runId, mode]);

  return (
    <View style={shared.screen}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Pressable onPress={onClose} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
          <Text style={{ color: palette.accent, fontSize: 15 }}>{'< Back'}</Text>
        </Pressable>
        <Button
          label={mode === 'transcript' ? 'Log' : 'Transcript'}
          variant="ghost"
          onPress={() => setMode(mode === 'transcript' ? 'log' : 'transcript')}
        />
      </View>

      <ScrollView style={{ flex: 1, marginTop: 12 }}>
        {error ? <Banner kind="error" message={error} /> : null}
        {!error && text === undefined ? <Text style={{ color: palette.textDim }}>Loading…</Text> : null}
        {text !== undefined ? <Text style={shared.mono}>{text || '(empty)'}</Text> : null}
      </ScrollView>
    </View>
  );
}

import { StyleSheet } from 'react-native';

/**
 * One palette, one shared stylesheet. Level-1 variables only (the global
 * palette below) — no per-component token layer. Every screen imports from
 * here rather than restating a hex value.
 */
export const palette = {
  background: '#0b0d10',
  surface: '#14181d',
  border: '#232830',
  text: '#e6e9ee',
  textDim: '#8b93a1',
  accent: '#5b8cff',
  danger: '#f87171',
  status: {
    running: '#f5c451',
    success: '#4ade80',
    failure: '#f87171',
    missed: '#fb923c',
    pending: '#8b93a1'
  }
} as const;

export const shared = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: palette.background,
    padding: 20
  },
  card: {
    backgroundColor: palette.surface,
    borderColor: palette.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  heading: {
    color: palette.text,
    fontSize: 20,
    fontWeight: '600'
  },
  mono: {
    color: palette.textDim,
    fontFamily: 'monospace',
    fontSize: 13
  }
});

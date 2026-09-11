import { ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View, ViewStyle } from 'react-native';
import { palette } from '../lib/theme';

/**
 * The shared component set every screen and tab draws from — nothing beyond
 * what stage 5 needs. Pressed-state opacity is the one micro-interaction;
 * touch targets stay at 44px or more throughout.
 */

///////////////////////////*Button*////////////////////////////

type ButtonVariant = 'primary' | 'danger' | 'ghost';

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  style?: ViewStyle;
}

export function Button({ label, onPress, variant = 'primary', disabled, style }: ButtonProps) {
  const background =
    variant === 'primary' ? palette.accent : variant === 'danger' ? palette.danger : 'transparent';
  const textColor = variant === 'ghost' ? palette.text : '#0b0d10';

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        buttonStyles.base,
        { backgroundColor: background, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
        variant === 'ghost' && buttonStyles.ghostBorder,
        style
      ]}
    >
      <Text style={[buttonStyles.label, { color: textColor }]}>{label}</Text>
    </Pressable>
  );
}

const buttonStyles = StyleSheet.create({
  base: {
    minHeight: 44,
    borderRadius: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center'
  },
  ghostBorder: {
    borderWidth: 1,
    borderColor: palette.border
  },
  label: {
    fontWeight: '600',
    fontSize: 15
  }
});

///////////////////////////*Row*////////////////////////////

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[rowStyles.row, style]}>{children}</View>;
}

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  }
});

///////////////////////////*Chip*////////////////////////////

interface ChipProps {
  label: string;
  onPress?: () => void;
  selected?: boolean;
  color?: string;
}

export function Chip({ label, onPress, selected, color }: ChipProps) {
  const borderColor = color ?? (selected ? palette.accent : palette.border);
  const content = (
    <View
      style={[
        chipStyles.chip,
        { borderColor, backgroundColor: selected ? `${palette.accent}22` : palette.surface }
      ]}
    >
      <Text style={[chipStyles.label, color ? { color } : null]}>{label}</Text>
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      {content}
    </Pressable>
  );
}

const chipStyles = StyleSheet.create({
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    minHeight: 32
  },
  label: {
    color: palette.text,
    fontSize: 13
  }
});

///////////////////////////*ConfirmSheet*////////////////////////////

interface ConfirmSheetProps {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmSheet({
  visible,
  title,
  message,
  confirmLabel = 'Confirm',
  destructive,
  onCancel,
  onConfirm
}: ConfirmSheetProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={sheetStyles.backdrop}>
        <View style={sheetStyles.sheet}>
          <Text style={sheetStyles.title}>{title}</Text>
          <Text style={sheetStyles.message}>{message}</Text>
          <Row style={{ marginTop: 20, gap: 12 }}>
            <Button label="Cancel" variant="ghost" onPress={onCancel} style={{ flex: 1 }} />
            <Button
              label={confirmLabel}
              variant={destructive ? 'danger' : 'primary'}
              onPress={onConfirm}
              style={{ flex: 1 }}
            />
          </Row>
        </View>
      </View>
    </Modal>
  );
}

///////////////////////////*PromptModal*////////////////////////////

interface PromptModalProps {
  visible: boolean;
  title: string;
  value: string;
  onChangeValue: (next: string) => void;
  onCancel: () => void;
  onSave: () => void;
  saveLabel?: string;
}

export function PromptModal({
  visible,
  title,
  value,
  onChangeValue,
  onCancel,
  onSave,
  saveLabel = 'Save'
}: PromptModalProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={sheetStyles.backdrop}>
        <View style={sheetStyles.sheet}>
          <Text style={sheetStyles.title}>{title}</Text>
          <TextInput
            value={value}
            onChangeText={onChangeValue}
            multiline
            style={sheetStyles.input}
            placeholderTextColor={palette.textDim}
            autoFocus
          />
          <Row style={{ marginTop: 20, gap: 12 }}>
            <Button label="Cancel" variant="ghost" onPress={onCancel} style={{ flex: 1 }} />
            <Button label={saveLabel} onPress={onSave} style={{ flex: 1 }} />
          </Row>
        </View>
      </View>
    </Modal>
  );
}

const sheetStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: '#000000aa',
    justifyContent: 'center',
    padding: 24
  },
  sheet: {
    backgroundColor: palette.surface,
    borderColor: palette.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 20
  },
  title: {
    color: palette.text,
    fontSize: 17,
    fontWeight: '600'
  },
  message: {
    color: palette.textDim,
    marginTop: 10,
    lineHeight: 20
  },
  input: {
    marginTop: 14,
    minHeight: 100,
    maxHeight: 260,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 10,
    padding: 12,
    color: palette.text,
    textAlignVertical: 'top'
  }
});

///////////////////////////*Banner*////////////////////////////

interface BannerProps {
  kind: 'error' | 'info';
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function Banner({ kind, message, actionLabel, onAction }: BannerProps) {
  const color = kind === 'error' ? palette.danger : palette.textDim;
  return (
    <View style={[bannerStyles.banner, { borderColor: color }]}>
      <Text style={[bannerStyles.text, { color }]}>{message}</Text>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, marginTop: 8 })}>
          <Text style={[bannerStyles.action, { color }]}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const bannerStyles = StyleSheet.create({
  banner: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    backgroundColor: palette.surface
  },
  text: {
    fontSize: 13,
    lineHeight: 18
  },
  action: {
    fontSize: 13,
    fontWeight: '600'
  }
});

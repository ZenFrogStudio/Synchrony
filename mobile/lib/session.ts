import AsyncStorage from '@react-native-async-storage/async-storage';
import { McpClient } from './mcp';

/**
 * The one connector URL and the one `McpClient` every screen shares, plus the
 * "forget this desktop" path every screen needs. Kept as module state rather
 * than a state-management library — there is exactly one of it.
 */

export const STORAGE_KEY = 'synchrony.connectorUrl';

let client: McpClient | undefined;
let navigateHome: (() => void) | undefined;

export function getClient(): McpClient | undefined {
  return client;
}

export function setClient(next: McpClient): void {
  client = next;
}

/** Called once by `App.tsx` so `forgetPairing` can route back to the Pair screen. */
export function setNavigateHome(fn: () => void): void {
  navigateHome = fn;
}

export async function forgetPairing(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
  client = undefined;
  navigateHome?.();
}

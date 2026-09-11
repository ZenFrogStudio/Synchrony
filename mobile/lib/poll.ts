import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { McpError } from './mcp';

/**
 * Polling is the only freshness mechanism MCP gives us (no push). This hook
 * covers every screen that polls: it runs `fn` on an interval while the app is
 * foregrounded, exposes `refresh()` for pull-to-refresh, and keeps the last
 * good `data` on screen when a poll fails rather than blanking the UI — the
 * error surfaces as a banner instead.
 */
export interface PollState<T> {
  data: T | undefined;
  error: string | undefined;
  refreshing: boolean;
  refresh: () => void;
}

export function usePoll<T>(fn: () => Promise<T>, ms: number): PollState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(async (manual: boolean) => {
    if (manual) setRefreshing(true);
    try {
      const next = await fnRef.current();
      setData(next);
      setError(undefined);
    } catch (err) {
      setError(err instanceof McpError ? err.message : 'Something went wrong fetching that.');
    } finally {
      if (manual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const tick = () => {
      if (cancelled || AppState.currentState !== 'active') return;
      run(false);
    };

    tick();
    timer = setInterval(tick, ms);

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') tick();
    });

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      sub.remove();
    };
  }, [run, ms]);

  const refresh = useCallback(() => {
    run(true);
  }, [run]);

  return { data, error, refreshing, refresh };
}

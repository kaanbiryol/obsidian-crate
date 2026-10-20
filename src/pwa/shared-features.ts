import { createContext, useContext, useEffect, useState } from 'react';
import { AUTH_TOKEN_KEY } from './config';
import { readingSession } from './reading/storage';
import { parseSharedFeatures, type SharedFeatures } from '@/protocol/feature-policy';

const CACHE_KEY = 'crate-shared-features';
const defaults: SharedFeatures = { reading: true, reminders: true };
// Data refreshes can repeat often; paused responses always check immediately.
const REFRESH_INTERVAL_MS = 5 * 60_000;
// Foregrounding repeats quickly; reconnecting always checks.
const FOREGROUND_MAX_AGE_MS = 30_000;
const refreshListeners = new Set<(immediate: boolean) => void>();
/** Re-read the shared policy after a data refresh, or at once after a paused response. */
export function requestSharedFeaturesRefresh(immediate = false): void {
  for (const listener of refreshListeners) listener(immediate);
}
export const SharedFeaturesContext = createContext(defaults);
export const useSharedFeatures = () => useContext(SharedFeaturesContext);
export function useServerFeatures(): SharedFeatures {
  const [features, setFeatures] = useState<SharedFeatures>(() => {
    try {
      if (!localStorage.getItem(AUTH_TOKEN_KEY) && !readingSession()?.token) return defaults;
      const value = parseSharedFeatures(JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null'));
      if (value) return value;
    } catch { /* Storage may be unavailable. */ }
    return defaults;
  });
  useEffect(() => {
    let alive = true, busy = false, checkedAt = 0;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      checkedAt = Date.now();
      try {
        const token = localStorage.getItem(AUTH_TOKEN_KEY) ?? readingSession()?.token;
        if (!token) return;
        const response = await fetch('/features', { cache: 'no-store', signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) return;
        const value = parseSharedFeatures(await response.json());
        const currentToken = localStorage.getItem(AUTH_TOKEN_KEY) ?? readingSession()?.token;
        if (alive && currentToken === token && value) {
          const serialized = JSON.stringify(value);
          if (localStorage.getItem(CACHE_KEY) !== serialized) localStorage.setItem(CACHE_KEY, serialized);
          setFeatures(current => current.reading === value.reading && current.reminders === value.reminders ? current : value);
        }
      } catch { /* Keep confirmed state while offline. */ }
      finally { busy = false; }
    };
    const requested = (immediate: boolean) => {
      if (immediate || Date.now() - checkedAt >= REFRESH_INTERVAL_MS) void refresh();
    };
    // Returning to the app or reconnecting checks; there is no timer.
    const focused = () => { if (Date.now() - checkedAt >= FOREGROUND_MAX_AGE_MS) void refresh(); };
    const online = () => { void refresh(); };
    void refresh();
    refreshListeners.add(requested);
    window.addEventListener('focus', focused); window.addEventListener('online', online);
    return () => { alive = false; refreshListeners.delete(requested); window.removeEventListener('focus', focused); window.removeEventListener('online', online); };
  }, []);
  return features;
}

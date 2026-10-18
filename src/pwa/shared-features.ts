import { createContext, useContext, useEffect, useState } from 'react';
import { AUTH_TOKEN_KEY } from './config';
import { readingSession } from './reading/storage';

export interface SharedFeatures { reading: boolean; reminders: boolean }
const CACHE_KEY = 'crate-shared-features';
const defaults: SharedFeatures = { reading: true, reminders: true };
// Data refreshes can repeat often; paused responses always check immediately.
const REFRESH_INTERVAL_MS = 5 * 60_000;
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
      const value = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as SharedFeatures | null;
      if (value && typeof value.reading === 'boolean' && typeof value.reminders === 'boolean') return value;
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
        const next = await response.json() as SharedFeatures;
        const currentToken = localStorage.getItem(AUTH_TOKEN_KEY) ?? readingSession()?.token;
        if (alive && currentToken === token && typeof next.reading === 'boolean' && typeof next.reminders === 'boolean') {
          const value = { reading: next.reading, reminders: next.reminders };
          const serialized = JSON.stringify(value);
          if (localStorage.getItem(CACHE_KEY) !== serialized) localStorage.setItem(CACHE_KEY, serialized);
          setFeatures(current => current.reading === value.reading && current.reminders === value.reminders ? current : value);
        }
      } catch { /* Keep confirmed state while offline. Older servers retain both features. */ }
      finally { busy = false; }
    };
    const requested = (immediate: boolean) => {
      if (immediate || Date.now() - checkedAt >= REFRESH_INTERVAL_MS) void refresh();
    };
    // Returning to the app or reconnecting checks at once; there is no timer.
    const check = () => { void refresh(); };
    void refresh();
    refreshListeners.add(requested);
    window.addEventListener('focus', check); window.addEventListener('online', check);
    return () => { alive = false; refreshListeners.delete(requested); window.removeEventListener('focus', check); window.removeEventListener('online', check); };
  }, []);
  return features;
}

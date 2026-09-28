import { createContext, useContext, useEffect, useState } from 'react';
import { AUTH_TOKEN_KEY } from './config';
import { readingSession } from './reading/storage';

export interface SharedFeatures { reading: boolean; reminders: boolean }
const CACHE_KEY = 'crate-shared-features';
const defaults: SharedFeatures = { reading: true, reminders: true };
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
    let alive = true, busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const token = localStorage.getItem(AUTH_TOKEN_KEY) ?? readingSession()?.token;
        if (!token) return;
        const response = await fetch('/features', { cache: 'no-store', signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) return;
        const next = await response.json() as SharedFeatures;
        const currentToken = localStorage.getItem(AUTH_TOKEN_KEY) ?? readingSession()?.token;
        if (alive && currentToken === token && typeof next.reading === 'boolean' && typeof next.reminders === 'boolean') { setFeatures(next); localStorage.setItem(CACHE_KEY, JSON.stringify(next)); }
      } catch { /* Keep confirmed state while offline. Older servers retain both features. */ }
      finally { busy = false; }
    };
    const check = () => { void refresh(); };
    check();
    const timer = window.setInterval(check, 15_000);
    window.addEventListener('focus', check); window.addEventListener('online', check);
    return () => { alive = false; clearInterval(timer); window.removeEventListener('focus', check); window.removeEventListener('online', check); };
  }, []);
  return features;
}

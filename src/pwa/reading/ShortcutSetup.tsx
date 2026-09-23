import React, { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/ui/shared/Button';
import { READING_SHORTCUT_URL } from '@/reading/shortcut';
import { ReadingApiError, readingRequest } from './api';
import { assertReadingSession, type ReadingSession } from './storage';

interface Pairing { pairingCode: string; expiresAt: number }

export function ShortcutSetup({ session }: { session: ReadingSession }) {
  const codeId = useId();
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [now, setNow] = useState(Date.now), [online, setOnline] = useState(navigator.onLine);
  const alive = useRef(false), working = useRef(false);
  useEffect(() => {
    alive.current = true;
    const update = () => { setNow(Date.now()); setOnline(navigator.onLine); };
    const timer = window.setInterval(update, 1000);
    window.addEventListener('online', update); window.addEventListener('offline', update); document.addEventListener('visibilitychange', update);
    return () => { alive.current = false; clearInterval(timer); window.removeEventListener('online', update); window.removeEventListener('offline', update); document.removeEventListener('visibilitychange', update); };
  }, []);
  const expired = pairing !== null && pairing.expiresAt <= now;
  const create = async () => {
    if (working.current) return;
    working.current = true; setBusy(true); setError(''); setMessage(''); setPairing(null);
    try {
      const next = await readingRequest<Pairing>('/reading/shortcut-pairing', session, '{}');
      const url = new URL(next.pairingCode);
      if (url.origin !== location.origin || url.pathname !== '/reading/shortcut-exchange' || url.search || !/^#[a-f0-9]{64}$/.test(url.hash) || !Number.isFinite(next.expiresAt)) throw new Error('Could not verify the pairing code. Update your Crate server and try again.');
      if (alive.current) { setPairing(next); setNow(Date.now()); }
    } catch (cause) { if (alive.current) setError(cause instanceof ReadingApiError && [404, 428].includes(cause.status) ? 'Update your Crate server, then reopen shortcut setup.' : cause instanceof Error ? cause.message : 'Could not create a pairing code. Try again.'); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  };
  const copy = async () => {
    if (!pairing || pairing.expiresAt <= Date.now()) { setNow(Date.now()); return; }
    try {
      assertReadingSession(session);
      await navigator.clipboard.writeText(pairing.pairingCode);
      if (alive.current) { setError(''); setMessage('Copied. Open the shortcut from your Shortcuts library and paste when asked.'); }
    } catch { if (alive.current) setError('Could not copy. Select the pairing code below and copy it manually.'); }
  };
  return <div className="crate-reading-shortcut">
    <p>Save links from the iPhone share sheet. Requires iOS 27 or later and an internet connection.</p>
    <ol>
      <li><h3>Install the shortcut</h3><p>Open the download in Shortcuts and select <strong>Add Shortcut</strong>. If it saves to Files, open it from <strong>Downloads</strong>.</p>
        <a className="crate-action-button" data-variant="outline" href={READING_SHORTCUT_URL} target="_blank" rel="noopener noreferrer">Download Save to Crate</a>
      </li>
      <li><h3>Connect to this library</h3><p>Create a pairing code, then run <strong>Save to Crate (iOS 27)</strong> from your Shortcuts library and paste it when asked.</p>
        <Button variant="primary" disabled={busy || !online} onClick={() => void create()}>{busy ? 'Creating code…' : pairing ? 'Create new pairing code' : 'Create pairing code'}</Button>
        {pairing && !expired && <div className="crate-reading-shortcut__code"><label htmlFor={codeId}>Pairing code</label><textarea id={codeId} readOnly rows={3} value={pairing.pairingCode} autoCapitalize="none" autoComplete="off" spellCheck={false} onFocus={event => event.currentTarget.select()} /><Button variant="outline" onClick={() => void copy()}>Copy pairing code</Button><p>Use once within {Math.max(1, Math.ceil((pairing.expiresAt - now) / 60_000))} minutes. Keep this code private. Creating a new code replaces the previous one.</p></div>}
        {expired && <p role="status">This pairing code expired. Create a new code to continue.</p>}
        {!online && <p role="status">Connect to the internet to pair your shortcut.</p>}
        {error && <p role="alert">{error}</p>}{message && !expired && <p role="status">{message}</p>}
      </li>
      <li><h3>Try it</h3><p>After <strong>Crate setup saved</strong> appears, open an article and select <strong>Share → Save to Crate (iOS 27)</strong>. Wait for <strong>Saved to Crate</strong>, then dismiss the sheet.</p></li>
    </ol>
    <p>The shortcut can save links but cannot read your library. Access lasts up to 90 days; revoke it in Obsidian’s connected devices. To reconnect, create a new code and run the shortcut from its library again.</p>
  </div>;
}

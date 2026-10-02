import React, { useEffect, useRef, useState } from 'react';
import { PwaButton as Button } from '../components/PwaButton';
import { SettingsSection } from '../components/SettingsSection';
import { CopyableText } from '@/ui/shared/CopyableText';
import { READING_SHORTCUT_URL } from '@/reading/shortcut';
import { ReadingApiError, readingRequest } from './api';
import { assertReadingSession, type ReadingSession } from './storage';

interface Pairing { pairingCode: string; expiresAt: number }

export function ShortcutSetup({ session }: { session: ReadingSession }) {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
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
    working.current = true; setBusy(true); setError(''); setPairing(null);
    try {
      const next = await readingRequest<Pairing>('/reading/shortcut-pairing', session, '{}');
      const url = new URL(next.pairingCode);
      if (url.origin !== location.origin || url.pathname !== '/reading/shortcut-exchange' || url.search || !/^#[a-f0-9]{64}$/.test(url.hash) || !Number.isFinite(next.expiresAt)) throw new Error('Could not verify the pairing code. Update your Crate server and try again.');
      if (alive.current) { setPairing(next); setNow(Date.now()); }
    } catch (cause) { if (alive.current) setError(cause instanceof ReadingApiError && [404, 428].includes(cause.status) ? 'Update your Crate server, then reopen shortcut setup.' : cause instanceof Error ? cause.message : 'Could not create a pairing code. Try again.'); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  };
  return <div className="crate-reading-shortcut">
    <div className="crate-reading-shortcut__intro"><p>Save articles from the iPhone share sheet.</p><span>iOS 27+ · Internet connection required</span></div>
    <ol aria-label="Shortcut setup steps">
      <li><SettingsSection title="1. Install the shortcut"><p>Download <strong>Save to Crate</strong>, then select <strong>Add Shortcut</strong>. If it opens in Files, find it in <strong>Downloads</strong>.</p>
        <a className="crate-action-button" data-variant="outline" data-size="touch" href={READING_SHORTCUT_URL} target="_blank" rel="noopener noreferrer">Download Save to Crate</a>
      </SettingsSection></li>
      <li><SettingsSection title="2. Connect your library"><p>Create a pairing code. In <strong>Shortcuts → All Shortcuts</strong>, run <strong>Save to Crate (iOS 27)</strong> and paste the code when asked.</p>
        <Button size="touch" variant="outline" disabled={busy || !online} onClick={() => void create()}>{busy ? 'Creating code…' : pairing ? 'Create new pairing code' : 'Create pairing code'}</Button>
        {pairing && !expired && <div className="crate-reading-shortcut__code">
          <CopyableText key={pairing.pairingCode} value={pairing.pairingCode} label="Pairing code" copyLabel="Copy pairing code" alwaysShow
            successMessage="Copied. Open the shortcut from your Shortcuts library and paste when asked."
            failureMessage="Could not copy. Select the pairing code below and copy it manually."
            beforeCopy={() => {
              if (pairing.expiresAt <= Date.now()) { setNow(Date.now()); return false; }
              assertReadingSession(session);
              return true;
            }} />
          <p>Use once within {Math.max(1, Math.ceil((pairing.expiresAt - now) / 60_000))} minutes. Keep this code private. Creating a new code replaces the previous one.</p>
        </div>}
        {expired && <p role="status">This pairing code expired. Create a new code to continue.</p>}
        {!online && <p role="status">Connect to the internet to pair your shortcut.</p>}
        {error && <p role="alert">{error}</p>}
      </SettingsSection></li>
      <li><SettingsSection title="3. Save your first article"><p>After <strong>Crate setup saved</strong> appears, open an article and select <strong>Share → Save to Crate (iOS 27)</strong>. Crate opens with your link. Select <strong>Save</strong> to store it.</p></SettingsSection></li>
    </ol>
    <SettingsSection title="Privacy and access"><p>The shortcut opens your link in Crate using a private URL fragment. Unlock Reading in Safari if asked. Your browser encrypts the saved link before syncing it; the shortcut cannot read your library. Reinstall the current shortcut after enabling encryption.</p></SettingsSection>
    <SettingsSection title="Updates and troubleshooting"><p>Install the current shortcut, then return here to create a pairing code. If setup fails, use <strong>Copy diagnostics</strong> or <strong>Report on GitHub</strong> on the error page. Select <strong>Save</strong> in Reading to finish saving your link.</p></SettingsSection>

  </div>;
}

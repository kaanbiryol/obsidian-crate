import React, { useEffect, useRef, useState } from 'react';
import { Download, KeyRound } from 'lucide-react';
import { PwaButton as Button } from '../components/PwaButton';
import { SettingsSection } from '../components/SettingsSection';
import { SetupStep, SetupSteps } from '../components/SetupSteps';
import { CopyableText } from '@/ui/shared/CopyableText';
import { READING_SHORTCUT_URL } from '@/reading/shortcut';
import { readingRequest } from './api';
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
      if (url.origin !== location.origin || url.pathname !== '/reading/shortcut-exchange' || url.search || !/^#[a-f0-9]{64}$/.test(url.hash) || !Number.isFinite(next.expiresAt)) throw new Error('Could not verify the pairing code. Try again.');
      if (alive.current) { setPairing(next); setNow(Date.now()); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not create a pairing code. Try again.'); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  };
  return <div className="crate-reading-shortcut">
    <SettingsSection title="Setup" description="Save articles from the iPhone share sheet. Requires iOS 27 or later and an internet connection.">
      <SetupSteps aria-label="Shortcut setup steps">
        <SetupStep number={1} title="Install the shortcut" extra={
          <a className="crate-action-button setup-step__action" data-variant="outline" href={READING_SHORTCUT_URL} target="_blank" rel="noopener noreferrer"><Download size={15} aria-hidden="true" />Download Save to Crate</a>
        }>Select <strong>Add Shortcut</strong> after it downloads. If it opens in Files, look in <strong>Downloads</strong>. After turning on encryption, install it again.</SetupStep>
        <SetupStep number={2} title="Connect your library" extra={<>
          {pairing && !expired ? <div className="crate-reading-shortcut__code">
            <CopyableText key={pairing.pairingCode} value={pairing.pairingCode} label="Pairing code" copyLabel="Copy code" alwaysShow
              buttonClassName="setup-step__action"
              successMessage="Copied. Open the shortcut from your Shortcuts library and paste when asked."
              failureMessage="Could not copy. Select the pairing code below and copy it manually."
              beforeCopy={() => {
                if (pairing.expiresAt <= Date.now()) { setNow(Date.now()); return false; }
                assertReadingSession(session);
                return true;
              }} />
            <p className="setup-step__status">Use once within {Math.max(1, Math.ceil((pairing.expiresAt - now) / 60_000))} minutes. Keep it private. A new code replaces this one.</p>
          </div> : null}
          <Button className="setup-step__action" variant="outline" disabled={busy || !online} onClick={() => void create()}><KeyRound size={15} aria-hidden="true" />{busy ? 'Creating code…' : pairing ? 'New code' : 'Create pairing code'}</Button>
          {expired && <p className="setup-step__status" role="status">This pairing code expired. Create a new code to continue.</p>}
          {!online && <p className="setup-step__status" role="status">Connect to the internet to pair your shortcut.</p>}
          {error && <p className="setup-step__status" role="alert">{error}</p>}
        </>}>Create a code, then run <strong>Save to Crate</strong> from <strong>Shortcuts → All Shortcuts</strong> and paste it.</SetupStep>
        <SetupStep number={3} title="Save your first article">After <strong>Crate setup saved</strong> appears, share an article to <strong>Save to Crate</strong>, then select <strong>Save</strong> in Crate.</SetupStep>
      </SetupSteps>
    </SettingsSection>
    <p className="setup-steps-note">Links reach Crate through a private URL fragment and are encrypted in your browser before syncing, so the shortcut can’t read your library.</p>
  </div>;
}

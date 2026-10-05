import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useAppConnection } from './AppConnection';
import { EncryptionUnlockCard } from '../components/EncryptionUnlockCard';
import { EmptyAuthState, ErrorState } from '../components/AuthStates';
import { PwaLaunchSplash } from '../components/PwaChrome';
import { PwaButton as Button } from '../components/PwaButton';
import { unlockWithRecoveryKey } from '../encryption-session';
import { unlockReadingWithCode } from '../reading/encryption-session';
import { exportReadingData } from '../reading/storage';
import { useSharedFeatures } from '../shared-features';
import { BrowserSetup, needsBrowserSetup } from './BrowserSetup';
import { AppPairing } from './AppPairing';
import { hasEncryptedSessionEvidence } from '../encryption-scope';
import { SESSION_RECOVERY_ISSUE } from './issues';

/** One app-level setup/recovery surface, regardless of the initial destination. */
export function AppConnectionGate({ section, onOpenFeature, children }: {
  section: 'reading' | 'reminders'; onOpenFeature: (section: 'reading' | 'reminders') => void; children: ReactNode;
}) {
  const app = useAppConnection();
  const features = useSharedFeatures();
  const previousSection = useRef(section);
  const returnButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (previousSection.current !== section) returnButton.current?.focus({ preventScroll: true });
    previousSection.current = section;
  }, [section]);
  const [contentSection, setContentSection] = useState<typeof section | null>(null);
  const [exportError, setExportError] = useState('');
  const [browserSetup, setBrowserSetup] = useState(needsBrowserSetup);
  const shell = (content: ReactNode) => <div className="crate-reminders-ui reminders-shadow-root pwa-shadow-root" data-ui-host="pwa">{content}</div>;
  const reading = app.reading;
  const remindersLocked = app.authToken && app.encryption.status === 'locked' ? app.encryption : null;
  const readingLocked = reading.lockedSession;
  const locked = section === 'reading' && readingLocked ? {
    message: reading.error ?? 'Unlock Crate to continue.', setupRequired: reading.encryptionSetupRequired,
    converting: reading.converting,
    unlock: (code: string) => unlockReadingWithCode(code, readingLocked),
  } : section === 'reminders' && remindersLocked ? {
    ...remindersLocked, unlock: unlockWithRecoveryKey,
  } : null;
  const other = section === 'reading' ? 'reminders' : 'reading';
  const otherReady = features[other] && (other === 'reminders'
    ? app.authToken && ['ready', 'legacy'].includes(app.encryption.status) : reading.session);
  const switchFeature = otherReady && <Button ref={returnButton} data-feature-recovery-switch onClick={() => onOpenFeature(other)}>Open {other === 'reading' ? 'Reading' : 'Reminders'}</Button>;
  const connectionScreen = () => {
    if (browserSetup) return shell(<BrowserSetup onContinue={() => setBrowserSetup(false)} />);
    if (!app.bootstrapped) return <PwaLaunchSplash />;
    if (locked) return shell(<EncryptionUnlockCard title={locked.converting ? 'Encryption conversion in progress' : 'Unlock Crate'}
      message={locked.message} setupRequired={locked.setupRequired} action="Unlock Crate" onUnlock={locked.converting ? undefined : locked.unlock}
      pairing={locked.converting ? undefined : <AppPairing key={section} feature={section} />}>
      {busy => <>
        {locked.converting && <p>In Obsidian, open <strong>Crate settings → Sync → Manage encryption</strong> and resume setup.</p>}
        {exportError && <p role="alert">{exportError}</p>}
        <Button disabled={busy} onClick={() => location.reload()}>Retry connection</Button>
        {switchFeature}
        {readingLocked && <Button disabled={busy} onClick={() => { void exportReadingData().catch((cause: unknown) => setExportError(cause instanceof Error ? cause.message : String(cause))); }}>Export saved changes</Button>}
        <p>Logging out removes this app’s saved content and unsynced changes from this device.</p>
        <Button disabled={busy || app.loggingOut} onClick={() => { void app.logOut(); }}>Log out</Button>
      </>}
    </EncryptionUnlockCard>);
    if (section === 'reading' && !reading.ready) return <PwaLaunchSplash />;
    if (!app.authToken && (section === 'reminders' || !reading.session && !reading.lockedSession && !reading.connecting)) {
      // Expiry removes credentials, but preserved encryption data still needs a
      // recovery/logout action after reload. It must not look like a fresh install.
      const issue = app.error ?? reading.issue ?? (!reading.session && !reading.lockedSession && hasEncryptedSessionEvidence(null, undefined) ? SESSION_RECOVERY_ISSUE : null);
      return shell(<>{issue ? <ErrorState issue={issue} onRetry={() => location.reload()} onLogout={() => { void app.logOut(); }} loggingOut={app.loggingOut} />
        : <EmptyAuthState />}{switchFeature}</>);
    }
    return null;
  };
  const screen = connectionScreen();
  const keepContent = !screen || Boolean(contentSection === other && app.bootstrapped && !browserSetup && otherReady);
  const nextContentSection = !screen ? section : keepContent ? contentSection : null;
  useLayoutEffect(() => { setContentSection(nextContentSection); }, [nextContentSection]);
  // Keep the connected feature's UI state while another feature needs setup.
  // Losing the displayed session clears its private UI, even if the other is connected.
  return <>
    <div hidden={!!screen} inert={!!screen} style={{ display: screen ? 'none' : 'contents' }}>
      {keepContent && children}
    </div>
    {screen}
  </>;
}

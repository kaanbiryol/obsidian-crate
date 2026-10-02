import { useState } from 'react';
import { unlockReadingWithCode } from './encryption-session';
import { exportReadingData, type ReadingSession } from './storage';
import { Button } from '@/ui/shared/Button';
import { logoutReadingApp } from './logout';
export function ReadingEncryptionUnlock({ session, message }: { session: ReadingSession; message: string }) {
  const [code, setCode] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  return <section className="auth-card crate-encryption-unlock" aria-label="Unlock encrypted Reading">
    <h2>Unlock Reading</h2><p>{message}</p>
    <p>In Obsidian, open Crate settings → Manage encryption and copy the web app key. Paste it once to unlock Reading and Reminders on this device.</p>
    <form onSubmit={event => { event.preventDefault(); setBusy(true); void unlockReadingWithCode(code, session).catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }); }}>
      <label htmlFor="reading-folder-key">Web app key</label>
      <input id="reading-folder-key" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={busy} value={code} onChange={event => setCode(event.target.value)} />
      <Button type="submit" disabled={busy || !code.trim()}>Unlock Reading</Button>
    </form>
    {error && <p role="alert">{error}</p>}
    <Button onClick={() => location.reload()}>Retry connection</Button>
    <Button onClick={() => { void exportReadingData().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))); }}>Export saved changes</Button>
    <p>Logging out deletes saved articles, keys and unsynced changes on this device. Export saved changes first if you need to recover them.</p>
    <Button onClick={() => { void logoutReadingApp().then(result => { if (result) setError(result); else location.reload(); }); }}>Log out and clear device data</Button>
  </section>;
}

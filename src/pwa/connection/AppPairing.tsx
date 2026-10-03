import { useEffect, useRef, useState } from 'react';
import { PwaButton as Button } from '../components/PwaButton';
import { pairingConnection } from './pairing-client';
import { requestAppPairing } from '../../encryption/pairing/session';
import { rememberPairingGrants } from '../web-app-unlock';
import { PairingEndedError } from '../../encryption/pairing/protocol';

export function AppPairing({ feature }: { feature: 'reading' | 'reminders' }) {
  const [view, setView] = useState<{ started?: boolean; code?: string; error?: string; importing?: boolean; ended?: boolean; received?: boolean }>({});
  const active = useRef<{ stop(): void; retry(): void; confirm(): void } | null>(null);
  useEffect(() => () => { active.current?.stop(); active.current = null; }, [feature]);
  const start = () => {
    if (active.current && !view.ended) { active.current.retry(); return; }
    active.current?.stop();
    active.current = null;
    const controller = new AbortController();
    let connection: ReturnType<typeof pairingConnection>;
    try { connection = pairingConnection(feature, controller.signal); }
    catch (error) {
      setView({ started: true, error: error instanceof Error ? error.message : 'Could not read the app connection. Retry.' });
      return;
    }
    let attempt: Awaited<ReturnType<typeof requestAppPairing>> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let confirmed = false;
    let expected: Awaited<ReturnType<typeof connection.encryption>>;
    const poll = async () => {
      if (running || controller.signal.aborted) return;
      clearTimeout(timer);
      if (document.hidden) { timer = setTimeout(() => { void poll(); }, 2500); return; }
      running = true;
      try {
        if (!attempt) {
          expected = await connection.encryption();
          connection.current();
          attempt = await requestAppPairing({ version: 1, id: crypto.randomUUID(), origin: location.origin,
            vaultId: expected.vaultId, generation: expected.generation, scopeId: expected.scope.id }, connection.transport, connection.current);
        }
        const result = await attempt.poll();
        connection.current();
        if (result.payload !== undefined) {
          // The recipient must authenticate the comparison too. A relay can
          // impersonate a responder and invent a different vault configuration;
          // receiving a packet alone is not evidence of approval in Obsidian.
          if (!confirmed) {
            setView({ started: true, code: result.code, received: true });
            timer = setTimeout(() => { void poll(); }, 2500);
            return;
          }
          setView({ started: true, code: result.code, importing: true });
          const latest = await connection.encryption();
          if (latest.vaultId !== expected.vaultId || latest.generation !== expected.generation || latest.scope.id !== expected.scope.id) throw new PairingEndedError('The vault changed. Start again.');
          await rememberPairingGrants(result.payload, latest, connection.localFolder, () => { connection.current(); return true; });
          connection.current();
          // Stored keys are durable first. A lost acknowledgement cannot undo
          // them; the relay packet expires even when cleanup is unreachable.
          await attempt.close(true).catch(() => {});
          connection.current();
          location.reload();
          return;
        }
        setView(previous => previous.code === result.code && !previous.error ? previous : { started: true, code: result.code });
        timer = setTimeout(() => { void poll(); }, 2500);
      } catch (error) {
        if (!controller.signal.aborted) setView(previous => ({ ...previous, importing: false, ended: error instanceof PairingEndedError || !!attempt && Date.now() >= attempt.expiresAt, error: error instanceof Error ? error.message : 'Could not connect. Try again.' }));
      } finally { running = false; }
    };
    active.current = {
      stop() {
        // Best effort cancellation begins while the captured connection is still
        // current; abort immediately fences any in-flight key import.
        if (attempt) void connection.cancel(attempt.id).catch(() => {});
        controller.abort(); clearTimeout(timer);
      },
      retry() { setView(previous => ({ ...previous, error: undefined })); void poll(); },
      confirm() { confirmed = true; void poll(); },
    };
    setView({ started: true });
    void poll();
  };
  const cancel = () => { active.current?.stop(); active.current = null; setView({}); };
  if (!view.started) return <Button variant="primary" size="touch" onClick={start}>Connect with Obsidian</Button>;
  return <div className="pwa-app-pairing">
    {!view.code && <p>In Obsidian, open <strong>Crate settings → Sync → Manage encryption → Connect web app</strong>.</p>}
    <div role="status" aria-live="polite">
      {view.code ? <><div className="pwa-app-pairing__verification"><span>Verification code</span><output className="pwa-app-pairing__code" aria-label="Verification code">{view.code}</output></div><p>{view.received ? 'Confirm only if this code matches the one you approved in Obsidian.' : <>Check that this code matches in Obsidian, then select <strong>Approve</strong>.</>}</p></> : <p>Waiting for Obsidian…</p>}
      {view.importing && <p>Unlocking Crate…</p>}
    </div>
    {view.error && <p role="alert">{view.error}</p>}
    {view.received && <Button variant="primary" size="touch" disabled={!!view.error} onClick={() => active.current?.confirm()}>Confirm and unlock</Button>}
    <div className="auth-card__actions">
      {view.error && <Button size="touch" onClick={start}>{view.ended ? 'Start again' : 'Try again'}</Button>}
      <Button variant="ghost" size="touch" onClick={cancel}>Cancel</Button>
    </div>
  </div>;
}

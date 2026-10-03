import { useRef, useState, type ReactNode } from 'react';
import { isIosOrIpados, isStandaloneApp } from '../config';
import { TextField } from '@/ui/shared/TextField';
import { PwaButton as Button } from './PwaButton';
import { AuthLayout } from './AuthStates';

/** Shared setup and recovery presentation; key validation stays in the sessions. */
export function EncryptionUnlockCard({ title, message, setupRequired = false, action, onUnlock, children, pairing }: {
  title: string; message: string; setupRequired?: boolean; action?: string;
  onUnlock?: (code: string) => Promise<void>;
  children: (busy: boolean) => ReactNode;
  pairing?: ReactNode;
}) {
  const [code, setCode] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [manual, setManual] = useState(false);
  const setup = setupRequired && isIosOrIpados() && isStandaloneApp();
  return <AuthLayout className="crate-encryption-unlock" title={setup ? 'Finish setting up Crate' : title}
    description={pairing && !manual ? 'Connect once to unlock Reading and Reminders.' : setup ? 'Unlock Reading and Reminders with your saved recovery key.' : message}>
      {pairing && !manual && pairing}
      {onUnlock && (!pairing || manual) && <>
        <p>In Obsidian, open <strong>Crate settings → Sync → Manage encryption</strong> and copy your <strong>Recovery key</strong>.</p>
        <form className="modal-form" aria-busy={busy} onSubmit={event => {
          event.preventDefault();
          if (pending.current || !code.trim()) return;
          pending.current = true; setBusy(true); setError('');
          void onUnlock(code).catch((cause: unknown) => {
            pending.current = false; setBusy(false);
            setError(cause instanceof Error && 'code' in cause && cause.code === 'ERR_JWE_DECRYPTION_FAILED'
              ? 'This key couldn’t unlock your vault. Check your saved recovery key.' : cause instanceof Error ? cause.message : String(cause));
          });
        }}>
          <TextField label="Recovery key" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false}
            value={code} onChange={event => setCode(event.target.value)} disabled={busy} error={error || undefined}
            description={setup ? 'This app remembers its keys for future visits.' : undefined} />
          <Button variant="primary" size="touch" type="submit" disabled={busy || !code.trim()}>{busy ? 'Unlocking…' : setup ? 'Unlock Crate' : action}</Button>
        </form>
      </>}
      {pairing && <Button variant="ghost" size="touch" disabled={busy} aria-expanded={manual} onClick={() => { setCode(''); setError(''); setManual(value => !value); }}>{manual ? 'Connect with Obsidian instead' : 'Use recovery key instead'}</Button>}
      {onUnlock ? <details className="crate-encryption-unlock__options">
        <summary>More options</summary>
        <div className="auth-card__actions">{children(busy)}</div>
      </details> : children(busy)}
  </AuthLayout>;
}

import { useState } from 'react';
import { unlockWithWebAppKey } from '../encryption-session';
import { PwaButton as Button } from './PwaButton';

export function EncryptionUnlock({ message, converting, onLogout }: { message: string; converting: boolean; onLogout: () => void }) {
	const [code, setCode] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	return <section className="auth-card crate-encryption-unlock" role="region" aria-label="Unlock encrypted reminders">
		<h2>{converting ? 'Encryption conversion in progress' : 'This device is locked'}</h2>
		<p>{message}</p>
		{converting ? <p>In Obsidian, open Crate settings → Sync → Manage encryption and resume conversion. Sync and notifications are paused until it finishes, then retry the connection here.</p> : <>
		<p>In Obsidian, open Crate settings → Sync → Manage encryption and copy the web app key. Paste it once to unlock Reading and Reminders on this device.</p>
		<form onSubmit={event => { event.preventDefault(); setBusy(true); setError(null);
			void unlockWithWebAppKey(code).catch((failure: unknown) => { setError(failure instanceof Error ? failure.message : String(failure)); setBusy(false); }); }}>
			<label htmlFor="crate-folder-key">Web app key</label>
			<input id="crate-folder-key" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={code}
				onChange={event => setCode(event.target.value)} disabled={busy} />
			<Button className="primary-button" type="submit" disabled={busy || !code.trim()}>{busy ? 'Unlocking…' : 'Unlock this device'}</Button>
		</form>
		{error && <p role="alert">{error}</p>}
		<p>On iPhone, paste the key in the installed Home Screen app too. Safari and the installed app may use separate storage.</p>
		</>}
		<Button className="secondary-button" type="button" disabled={busy} onClick={() => window.location.reload()}>Retry connection</Button>
		<Button className="secondary-button" type="button" disabled={busy} onClick={onLogout}>Log out</Button>
	</section>;
}

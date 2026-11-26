import { useEffect, useRef, useState } from 'react';
import { Download, KeyRound, Link2 } from 'lucide-react';
import { PwaButton as Button } from '../components/PwaButton';
import { SettingsSection } from '../settings/SettingsSection';
import { SetupStep, SetupSteps } from '../components/SetupSteps';
import { CopyableText } from '@/ui/shared/CopyableText';
import { DEVELOPMENT_SHORTCUT_PATH, READING_SHORTCUT_URL, readingShortcutPairingUrl } from '@/reading/shortcut';
import { readingRequest } from './api';
import { assertReadingSession, isReadingSessionCurrent, type ReadingSession } from './session/session';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

interface Pairing { pairingCode: string; expiresAt: number }

declare const __CRATE_DEVELOPMENT_SHORTCUT_AVAILABLE__: boolean | undefined;
// Development Workers serve the shortcut signed from the working tree.
const shortcutDownloadUrl = typeof __CRATE_DEVELOPMENT_SHORTCUT_AVAILABLE__ === 'boolean' && __CRATE_DEVELOPMENT_SHORTCUT_AVAILABLE__ ? DEVELOPMENT_SHORTCUT_PATH : READING_SHORTCUT_URL;

export function ShortcutSetup({ session }: { session: ReadingSession }) {
	const [pairing, setPairing] = useState<Pairing | null>(null);
	const [busy, setBusy] = useState(false), [error, setError] = useState('');
	const [now, setNow] = useState(Date.now), online = useOnlineStatus(() => setNow(Date.now()));
	const alive = useRef(false), working = useRef(false);
	useEffect(() => {
		alive.current = true;
		const update = () => setNow(Date.now());
		const timer = window.setInterval(update, 1000);
		document.addEventListener('visibilitychange', update);
		return () => { alive.current = false; clearInterval(timer); document.removeEventListener('visibilitychange', update); };
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
		<SettingsSection title="Setup" description="Save articles from the iPhone share sheet. Requires iOS 27 or later.">
			<SetupSteps aria-label="Shortcut setup steps">
				<SetupStep number={1} title="Install the shortcut" extra={
					<a className="crate-action-button setup-step__action" data-variant="outline" href={shortcutDownloadUrl} target="_blank" rel="noopener noreferrer"
						// Prepare a code while the shortcut installs, so connecting is one tap on return.
						onClick={() => { if (online && (!pairing || pairing.expiresAt <= Date.now())) void create(); }}><Download size={15} aria-hidden="true" />Download Save to Crate</a>
				}>Select <strong>Add Shortcut</strong>, then come back here.</SetupStep>
				<SetupStep number={2} title="Connect your library" extra={<>
					{pairing && !expired ? <>
						<a className="crate-action-button setup-step__action" data-variant="outline" href={readingShortcutPairingUrl(pairing.pairingCode)}
							onClick={event => {
								if (pairing.expiresAt <= Date.now()) { event.preventDefault(); setNow(Date.now()); }
								else if (!isReadingSessionCurrent(session)) { event.preventDefault(); setError('Reading sign-in changed. Reload this page.'); }
							}}><Link2 size={15} aria-hidden="true" />Connect in Shortcuts</a>
						<details className="crate-reading-shortcut__fallback">
							<summary>Shortcuts didn’t open?</summary>
							<p className="setup-step__status">Copy this code, run <strong>Save to Crate</strong> from <strong>Shortcuts → All Shortcuts</strong>, and paste it. It works once, within {Math.max(1, Math.ceil((pairing.expiresAt - now) / 60_000))} minutes.</p>
							<div className="crate-reading-shortcut__code">
								<CopyableText key={pairing.pairingCode} value={pairing.pairingCode} label="Pairing code" copyLabel="Copy code" alwaysShow
									buttonClassName="setup-step__action"
									successMessage="Copied. Open the shortcut from your Shortcuts library and paste when asked."
									failureMessage="Could not copy. Select the pairing code below and copy it manually."
									beforeCopy={() => {
										if (pairing.expiresAt <= Date.now()) { setNow(Date.now()); return false; }
										assertReadingSession(session);
										return true;
									}} />
							</div>
						</details>
					</> : <Button className="setup-step__action" variant="outline" disabled={busy || !online} onClick={() => void create()}><KeyRound size={15} aria-hidden="true" />{busy ? 'Creating code…' : 'Create pairing code'}</Button>}
					{expired && <p className="setup-step__status" role="status">This pairing code expired. Create a new code to continue.</p>}
					{!online && <p className="setup-step__status" role="status">Connect to the internet to pair your shortcut.</p>}
					{error && <p className="setup-step__status" role="alert">{error}</p>}
				</>}>Select <strong>Connect in Shortcuts</strong>, then <strong>OK</strong>. When Shortcuts asks to connect to your server, select <strong>Always Allow</strong> so saving doesn’t ask again.</SetupStep>
				<SetupStep number={3} title="Save your first article">Share any link to <strong>Save to Crate</strong>.</SetupStep>
			</SetupSteps>
		</SettingsSection>
		<p className="setup-steps-note">Your server downloads each shared article. The shortcut can’t read your library.</p>
	</div>;
}

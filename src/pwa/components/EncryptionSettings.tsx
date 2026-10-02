import { useSyncExternalStore } from 'react';
import { encryptionSnapshot, subscribeEncryption } from '../encryption-session';
import type { SettingsSnapshot } from '../settings-store';

export function EncryptionSettings({ reading, remindersConnected }: { reading: SettingsSnapshot['reading']; remindersConnected: boolean }) {
	const encryption = useSyncExternalStore(subscribeEncryption, encryptionSnapshot);
	return <section className="settings-panel__section" aria-labelledby="settings-encryption-title">
		<h3 id="settings-encryption-title" className="settings-panel__title">Encryption</h3>
		<div className="settings-group" aria-live="polite">
			<div className="settings-row">
				<div className="settings-row__copy">
					<strong>Reminders encryption</strong>
					<span>{encryption.status === 'ready' ? 'Active · conversion complete. This device is unlocked.'
						: encryption.status === 'legacy' ? 'Not enabled. Set up encryption in Crate in Obsidian.'
							: encryption.status === 'locked' ? encryption.message : remindersConnected ? 'Checking this device…' : 'Connect Reminders to check this device.'}</span>
				</div>
			</div>
			{encryption.status === 'ready' && <>
				<div className="settings-row settings-row--value"><span>Encrypted folder</span><strong title={encryption.folderPath}>{encryption.folderPath}</strong></div>
				<div className="settings-row"><div className="settings-row__copy">
					<strong>Notification keys ready</strong>
					<span>Saved on this device for background alerts. Push permission and delivery status appear under Notifications.</span>
				</div></div>
				<div className="settings-row"><div className="settings-row__copy">
					<span>The server can still see file paths and notification times. Keep your recovery key outside the vault.</span>
				</div></div>
			</>}
			<div className="settings-row"><div className="settings-row__copy">
				<strong>Reading encryption</strong>
				<span>{reading?.encryption?.status === 'ready' ? 'Active · this Reading folder is unlocked.'
					: reading?.encryption?.status === 'legacy' ? 'Not enabled. Set up encryption in Crate in Obsidian.'
						: reading?.encryption?.status === 'locked' ? 'Unlock or verify Reading in the app before using this folder.'
							: reading?.ready ? 'Connect Reading to check this device.' : 'Checking Reading…'}</span>
			</div></div>
			{reading?.encryption?.status === 'ready' && <div className="settings-row settings-row--value"><span>Encrypted Reading folder</span><strong title={reading.encryption.folderPath}>{reading.encryption.folderPath}</strong></div>}
		</div>
	</section>;
}

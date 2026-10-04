import { useSyncExternalStore } from 'react';
import { encryptionSnapshot, subscribeEncryption } from '../encryption-session';
import type { SettingsSnapshot } from '../settings-store';
import { SettingsSection } from './SettingsSection';
import { SettingsRow } from './SettingsRow';

export function EncryptionSettings({ reading, remindersConnected }: { reading: SettingsSnapshot['reading']; remindersConnected: boolean }) {
	const encryption = useSyncExternalStore(subscribeEncryption, encryptionSnapshot);
	const reminderStatus = encryption.status === 'ready' ? 'Unlocked' : encryption.status === 'legacy' ? 'Not enabled'
		: encryption.status === 'locked' ? encryption.converting ? 'Converting' : 'Locked' : remindersConnected ? 'Checking…' : 'Not connected';
	const readingStatus = reading?.encryption?.status === 'ready' ? 'Unlocked' : reading?.encryption?.status === 'legacy' ? 'Not enabled'
		: reading?.encryption?.status === 'locked' ? 'Locked' : reading?.ready ? 'Not connected' : 'Checking…';
	const reminderDescription = encryption.status === 'locked' ? encryption.message
		: encryption.status === 'checking' && !remindersConnected ? 'Connect Reminders to check this device.' : undefined;
	const readingDescription = reading?.encryption?.status === 'locked' ? 'Unlock or verify Reading in the app before using this folder.'
		: reading?.ready && !reading.encryption ? 'Connect Reading to check this device.' : undefined;
	const showSetup = encryption.status === 'legacy' || reading?.encryption?.status === 'legacy';
	const hasUnlockedFolder = encryption.status === 'ready' || reading?.encryption?.status === 'ready';
	return <SettingsSection title="Encryption" groupProps={{ 'aria-live': 'polite' }}>
		<SettingsRow title="Reminders" description={reminderDescription}><span className="settings-value">{reminderStatus}</span></SettingsRow>
		<SettingsRow title="Reading" description={readingDescription}><span className="settings-value">{readingStatus}</span></SettingsRow>
		{showSetup && <p className="settings-help">Set up encryption in Crate in Obsidian.</p>}
		{hasUnlockedFolder && <details className="settings-encryption-details">
			<summary>Encryption details</summary>
			{encryption.status === 'ready' && <>
				<SettingsRow className="settings-row--value"><span>Encrypted folder</span><strong title={encryption.folderPath}>{encryption.folderPath}</strong></SettingsRow>
				<SettingsRow title="Notification keys ready" description="Saved on this device for background alerts. Push permission and delivery status appear under Reminders." />
			</>}
			{reading?.encryption?.status === 'ready' && <SettingsRow className="settings-row--value"><span>Encrypted Reading folder</span><strong title={reading.encryption.folderPath}>{reading.encryption.folderPath}</strong></SettingsRow>}
			<p className="settings-help">The server can still see file paths and notification times. Keep your recovery key outside the vault.</p>
		</details>}
	</SettingsSection>;
}

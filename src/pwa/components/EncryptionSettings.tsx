import { useSyncExternalStore } from 'react';
import { encryptionSnapshot, subscribeEncryption } from '../encryption/encryption-session';
import type { SettingsSnapshot } from '../settings-store';
import { SettingsSection } from './SettingsSection';
import { SettingsRow } from './SettingsRow';

export function EncryptionSettings({ reading, remindersConnected }: { reading: SettingsSnapshot['reading']; remindersConnected: boolean }) {
	const encryption = useSyncExternalStore(subscribeEncryption, encryptionSnapshot);
	const reminderStatus = encryption.status === 'ready' ? 'Unlocked' : encryption.status === 'unencrypted' ? 'Not enabled'
		: encryption.status === 'locked' ? encryption.converting ? 'Converting' : 'Locked' : remindersConnected ? 'Checking…' : 'Not connected';
	const readingStatus = reading?.encryption?.status === 'ready' ? 'Unlocked' : reading?.encryption?.status === 'unencrypted' ? 'Not enabled'
		: reading?.encryption?.status === 'locked' ? 'Locked' : reading?.ready ? 'Not connected' : 'Checking…';
	const reminderDescription = encryption.status === 'locked' ? encryption.message
		: encryption.status === 'checking' && !remindersConnected ? 'Connect Reminders to check this device.' : undefined;
	const readingDescription = reading?.encryption?.status === 'locked' ? 'Unlock or verify Reading in the app before using this folder.'
		: reading?.ready && !reading.encryption ? 'Connect Reading to check this device.' : undefined;
	const hasUnlockedFolder = encryption.status === 'ready' || reading?.encryption?.status === 'ready';
	const inUse = [encryption.status, reading?.encryption?.status].some(status => status === 'ready' || status === 'locked');
	if (!inUse) return null;
	return <SettingsSection title="Encryption" groupProps={{ 'aria-live': 'polite' }}>
		<SettingsRow title="Reminders" description={reminderDescription}><span className="settings-value">{reminderStatus}</span></SettingsRow>
		<SettingsRow title="Reading" description={readingDescription}><span className="settings-value">{readingStatus}</span></SettingsRow>
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

/** Encryption is off for at least one connected feature: point to where it is set up. */
export function EncryptionSetupHint({ reading }: { reading: SettingsSnapshot['reading'] }) {
	const encryption = useSyncExternalStore(subscribeEncryption, encryptionSnapshot);
	if (encryption.status !== 'unencrypted' && reading?.encryption?.status !== 'unencrypted') return null;
	return <p className="settings-help">Encryption is off. Set it up in Obsidian under <strong>Crate settings → Sync → Manage encryption</strong>.</p>;
}

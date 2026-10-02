import { resetReadingEncryption } from './reading/encryption-lifecycle';
import { AUTH_TOKEN_KEY } from './config';
import { READING_SESSION_KEY } from './reading/storage';

/** Capture before any cleanup awaits; a new enrollment owns its own saved keys. */
export function captureEncryptionCleanupAuthority(): () => boolean {
	const reminders = localStorage.getItem(AUTH_TOKEN_KEY);
	const reading = localStorage.getItem(READING_SESSION_KEY);
	return () => {
		const currentReading = localStorage.getItem(READING_SESSION_KEY);
		const currentReminders = localStorage.getItem(AUTH_TOKEN_KEY);
		return (currentReminders === null || currentReminders === reminders) && (currentReading === null || currentReading === reading);
	};
}

export function clearEncryptionSessionMarkers(isCurrent: () => boolean): void {
  if (isCurrent()) resetReadingEncryption();
	if (!isCurrent()) return;
	for (const key of Object.keys(localStorage)) {
		if (key.startsWith('crate-encryption-session:')) localStorage.removeItem(key);
	}
}

/** A broken attempt store must not prevent independent key removal. */
export async function clearPersistedEncryption(isCurrent: () => boolean): Promise<void> {
	const results = await Promise.allSettled([
		import('./encrypted-reminder-attempts').then(module => module.clearEncryptedReminderAttempts(isCurrent)),
		import('./encryption-keys').then(module => module.clearReminderKeys(isCurrent)),
	]);
	if (results.some(result => result.status === 'rejected')) throw new Error('Encrypted data or keys could not be removed. Clear this site’s data in browser settings.');
}

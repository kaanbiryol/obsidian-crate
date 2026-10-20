import { clearReadingData } from '../reading/storage';
import { clearReminderDrafts } from '../reminders/editor/reminder-drafts';
import { clearReminderOutbox } from '../reminders/outbox/reminder-outbox-storage';
import { clearCachedReminderSnapshots } from '../reminders/cache/reminder-cache';
import { clearEncryptionSessionMarkers, clearPersistedEncryption } from '../encryption/encryption-cleanup';

/** Clear browser storage after the session's in-memory authority is revoked.
 * Steps run in order and independently: a failure is reported and the remaining
 * steps still run. Expiry or replacement keeps private data and only removes
 * the offline reminder copy; explicit logout also discards drafts, pending
 * changes, Reading data and encryption state. */
export async function clearLocalData(isCurrent: () => boolean, report: (message: string) => void, discardPrivateData: boolean): Promise<void> {
	if (discardPrivateData) {
		try { clearEncryptionSessionMarkers(isCurrent); }
		catch { report('The previous encryption session could not be cleared. Clear this site’s data before enrolling again.'); }
	}
	if (discardPrivateData && !clearReminderDrafts()) report('Drafts could not be cleared. Clear this site’s data in browser settings.');
	try { if (discardPrivateData) clearReminderOutbox(); }
	catch { report('Could not clear pending changes from this device. Clear this site’s data in browser settings.'); }
	if (discardPrivateData) { try { await clearReadingData(isCurrent); } catch { report('Reading data could not be cleared. Clear this site’s data in browser settings.'); } }
	if (!await clearCachedReminderSnapshots(isCurrent).catch(() => false)) {
		report('Offline data could not be cleared. Close other Crate tabs, then clear this site’s data in browser settings.');
	}
	if (discardPrivateData) {
		try { await clearPersistedEncryption(isCurrent); }
		catch { report('Encrypted data or keys could not be removed. Clear this site’s data in browser settings.'); }
	}
}

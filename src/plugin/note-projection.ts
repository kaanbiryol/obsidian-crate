import type { NoteProjectionFactory } from '../sync/worker-api/client';
import { importNotificationKeys } from '../encryption/notification-keys';
import { importEncryptionSecret } from '../encryption/envelope';
import { deriveReadingSearchKey } from '../encryption/reading-search';
import { createReminderProjection } from '../reminders/core/encrypted-schedule-projection';
import { readingUploadCard } from '../reading/core/reading-card-upload';

/** A note inside `readingFolder()` carries its Reading card, and other notes inside
 * `reminderFolders()` their encrypted notification schedules, so the server can list and
 * schedule them without reading the note. */
export function createNoteProjection(reminderFolders: () => readonly string[], readingFolder?: () => string | null): NoteProjectionFactory {
	return async bundle => {
		const notifications = await importNotificationKeys(bundle.vaultId, bundle.notifications);
		const cardKeys = { vaultId: bundle.vaultId, key: await importEncryptionSecret(bundle.vault), keyGeneration: bundle.generation,
			searchKey: await deriveReadingSearchKey(bundle.vaultId, bundle.vault) };
		return async (path, bytes, wire) =>
			await readingUploadCard(readingFolder?.(), path, wire, bytes, cardKeys) ?? createReminderProjection(notifications, reminderFolders(), path, bytes);
	};
}

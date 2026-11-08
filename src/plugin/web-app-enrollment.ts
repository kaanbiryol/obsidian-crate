import type CratePlugin from './CratePlugin';
import { captureSyncApiConnection } from './server-request';
import { loadEncryptionKeys } from '../sync/encryption/key-storage';
import { policySettings } from '../reminders/notification-policy-sync';

const SETUP_CHANGED = 'The connection changed. Create a new setup link.';

/** A short-lived setup link that connects the web app to this vault's reminders folder.
 * Every request uses the connection captured here, and no link is returned once that
 * connection or a feature folder changes. */
export async function buildEnrollmentUrl(plugin: CratePlugin): Promise<string> {
	const connection = captureSyncApiConnection(plugin);
	const { api } = connection;
	if (!api) throw new Error('Sync API is unavailable');
	const keys = loadEncryptionKeys(plugin.secretStorage);
	const folder = plugin.remindersSettings.remindersFolderPath;
	const readingFolder = plugin.settings.reading.folderPath;
	const assertCurrent = () => {
		connection.assertCurrent();
		if (plugin.remindersSettings.remindersFolderPath !== folder || plugin.settings.reading.folderPath !== readingFolder) {
			throw new Error(SETUP_CHANGED);
		}
	};

	if (plugin.settings.pushEnabled) await api.ensureNotificationPolicy(policySettings(plugin));
	assertCurrent();
	const { token, browserToken } = await api.createRemindersEnrollmentToken(folder);
	assertCurrent();
	const subscribeUrl = new URL('notifications', `${api.getWorkerUrl()}/`);
	if (keys) {
		// The link never carries the recovery key: links land in browser history and
		// sync, and the key cannot be rotated. The app unlocks by pairing instead.
		// The fragment never reaches the server, so the folder's plaintext name can travel in it.
		subscribeUrl.hash = new URLSearchParams({ crateFolder: folder }).toString();
	}
	subscribeUrl.searchParams.set('token', token);
	if (browserToken) subscribeUrl.searchParams.set('browserToken', browserToken);
	if (!keys) subscribeUrl.searchParams.set('folder', folder);
	subscribeUrl.searchParams.set('upcomingDays', String(plugin.remindersSettings.upcomingDaysDefault ?? 7));
	if (plugin.remindersSettings.allDayNotificationTime) {
		subscribeUrl.searchParams.set('allDayTime', plugin.remindersSettings.allDayNotificationTime);
	}
	return subscribeUrl.toString();
}

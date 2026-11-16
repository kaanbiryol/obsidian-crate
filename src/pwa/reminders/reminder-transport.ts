import { REMINDERS_FOLDER_CHANGED } from '@/protocol/web-session';
import { adoptReminderFolder } from '../config';
import { ConnectionError } from '../connection/issues';
import type { ApiFetchEncryption } from '../connection/api-fetch';
import { EncryptedReminderApi } from './encrypted-reminder-api';
import { prepareReminderEncryption } from './encryption-session';

/** What Reminders hands `makeApiFetch`: the app credential's encryption check, the client
 * that answers encrypted reminder routes, and following folder changes made in Obsidian. */
export const reminderTransport: ApiFetchEncryption = {
	prepare: (token, rawFetch, refresh) => prepareReminderEncryption(token, rawFetch, refresh),
	router: (keys, rawFetch) => new EncryptedReminderApi(keys, rawFetch),
	inspect: followFolderChange,
};

/** Obsidian changed the reminders folder and the server moved this session with it. */
async function followFolderChange(path: string, response: Response, session: Parameters<ApiFetchEncryption['inspect']>[2]): Promise<void> {
	if (response.status !== 403 || !path.startsWith('/reminders/')) return;
	const body = await response.clone().json().catch(() => null) as { code?: unknown; folderPath?: unknown } | null;
	if (body?.code !== REMINDERS_FOLDER_CHANGED || typeof body.folderPath !== 'string' || !body.folderPath) return;
	// An encrypted folder's name comes from its sealed label, which the refresh opens.
	if (session.encrypted()) await session.refresh();
	else adoptReminderFolder(body.folderPath);
	throw new ConnectionError('unavailable', 'The reminders folder changed in Obsidian. Showing the new folder.');
}

import { hasReminderEncryptionEvidence, reminderEncryptionSnapshot } from './encryption-session';
import { loadCachedReminderSnapshot } from './cache/reminder-cache';
import { createReminderListCursor } from './reminder-list-cursor';
import type { ApiFetch } from '../types';
import type { CachedReminderSnapshot } from './types';

/** The offline copy and first list request started during the encryption check. */
export interface StartupRead {
	key: string;
	cached: Promise<CachedReminderSnapshot | null>;
	list: Promise<{ path: string; headers: Headers; response: Promise<Response> }>;
}

/** Identifies the folder and credential a read belongs to. */
export function startupReadKey(folderPath: string, authToken: string | null): string {
	return `${folderPath}\0${authToken}`;
}

/** Without encryption evidence the vault is most likely unencrypted, so the offline
 * copy is read and the first list request sent while the startup encryption check
 * runs. Neither is shown or applied until that check accepts unencrypted mode. */
export function beginStartupRead(folderPath: string, authToken: string, readUnverified: ApiFetch): StartupRead | null {
	if (hasReminderEncryptionEvidence() || reminderEncryptionSnapshot().status !== 'checking') return null;
	// A new enrollment link replaces this credential during startup.
	const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
	if (params.get('token') || params.get('browserToken')) return null;
	const cached = loadCachedReminderSnapshot(folderPath);
	const list = cached.then(snapshot => {
		const startup = createReminderListCursor();
		if (snapshot) startup.hydrate(snapshot);
		const request = startup.request(folderPath, (snapshot?.issues ?? []).length === 0);
		const response = readUnverified(request.path, { headers: request.headers });
		// Failures are handled where the response is used.
		response.catch(() => undefined);
		return { ...request, response };
	});
	return { key: startupReadKey(folderPath, authToken), cached, list };
}

/** The startup request, when it matches this first read and the encryption check
 * accepted unencrypted mode. A failed startup request is sent again normally. */
export async function takeStartupResponse(startup: StartupRead | null, key: string, path: string, headers: Headers, apiFetch: ApiFetch): Promise<Response | undefined> {
	if (!startup || startup.key !== key || reminderEncryptionSnapshot().status !== 'unencrypted') return undefined;
	const early = await startup.list;
	if (early.path !== path || early.headers.get('If-None-Match') !== headers.get('If-None-Match')) return undefined;
	return early.response.catch(() => apiFetch(path, { headers }));
}

/** The startup read hydration may reuse. It ran without a cipher, so an unlocked
 * session reads again. */
export function reusableStartupRead(startup: StartupRead | null, key: string): StartupRead | null {
	return startup?.key === key && reminderEncryptionSnapshot().status !== 'ready' ? startup : null;
}

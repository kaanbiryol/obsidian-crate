import { capturePwaSession } from './session-generation';
import type { CachedReminderSnapshot, ReminderRecord, ReminderSourceIssue } from './types';
import { AUTH_TOKEN_KEY } from './config';
import { CACHE_STORE_NAME, FRESHNESS_STORE_NAME, deleteCacheDatabase, openCacheDatabase, reminderCacheHealth, reportCacheProblem } from './reminder-cache-database';
import { normalizeSnapshot } from './reminder-cache-validation';

let cacheGeneration = 0;

interface CacheFreshness {
	folderPath: string;
	savedAt: number;
	etag: string;
}

// Bind disposable content to the actual session even when an old tab blocks
// logout deletion. No credential is stored in the snapshot.
async function cacheSessionScope(): Promise<string> {
	const token = typeof localStorage === 'undefined' ? '' : localStorage.getItem(AUTH_TOKEN_KEY) ?? '';
	const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function readIndexedDbSnapshot(folderPath: string): Promise<CachedReminderSnapshot | null> {
	const sessionScope = await cacheSessionScope();
	const database = await openCacheDatabase();
	try {
		return await new Promise((resolve, reject) => {
			const transaction = database.transaction([CACHE_STORE_NAME, FRESHNESS_STORE_NAME], 'readonly');
			const request = transaction.objectStore(CACHE_STORE_NAME).get(folderPath);
			const freshnessRequest = transaction.objectStore(FRESHNESS_STORE_NAME).get(folderPath);
			transaction.oncomplete = () => {
				const raw = request.result as { sessionScope?: string } | undefined;
				const snapshot = raw?.sessionScope === sessionScope ? normalizeSnapshot(raw, folderPath) : null;
				reportCacheProblem(raw && !snapshot ? 'damaged' : null);
				const freshness = freshnessRequest.result as CacheFreshness | undefined;
				// A late revalidation must never update the timestamp of a different revision.
				if (snapshot?.etag && freshness?.etag === snapshot.etag && Number.isFinite(freshness.savedAt)) {
					snapshot.savedAt = Math.max(snapshot.savedAt, freshness.savedAt);
				}
				resolve(snapshot);
			};
			transaction.onerror = () => reject(transaction.error ?? new Error('Could not read reminder cache'));
			transaction.onabort = () => reject(transaction.error ?? new Error('Reminder cache read was aborted'));
		});
	} finally {
		database.close();
	}
}

async function writeIndexedDbSnapshot(snapshot: CachedReminderSnapshot): Promise<void> {
	const sessionCurrent = capturePwaSession();
	const generation = cacheGeneration;
	const sessionScope = await cacheSessionScope();
	const database = await openCacheDatabase();
	try {
		if (!sessionCurrent() || generation !== cacheGeneration) return;
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction([CACHE_STORE_NAME, FRESHNESS_STORE_NAME], 'readwrite');
			transaction.objectStore(CACHE_STORE_NAME).put({ ...snapshot, sessionScope });
			transaction.objectStore(FRESHNESS_STORE_NAME).delete(snapshot.folderPath);
			transaction.oncomplete = () => { reportCacheProblem(null); resolve(); };
			transaction.onerror = () => reject(transaction.error ?? new Error('Could not write reminder cache'));
			transaction.onabort = () => reject(transaction.error ?? new Error('Reminder cache write was aborted'));
		});
	} finally {
		database.close();
	}
}

export async function loadCachedReminderSnapshot(folderPath: string): Promise<CachedReminderSnapshot | null> {
	try {
		const sessionCurrent = capturePwaSession();
		const generation = cacheGeneration;
		const snapshot = await readIndexedDbSnapshot(folderPath);
		return sessionCurrent() && generation === cacheGeneration ? snapshot : null;
	} catch {
		if (!reminderCacheHealth.getSnapshot()) reportCacheProblem('unavailable');
		return null;
	}
}

export async function saveCachedReminderSnapshot(
	folderPath: string,
	reminders: ReminderRecord[],
	projects: string[],
	savedAt = Date.now(),
	etag?: string,
	issues: ReminderSourceIssue[] = [],
): Promise<void> {
	const snapshot: CachedReminderSnapshot = { folderPath, reminders, projects, savedAt, etag, issues };
	try {
		if (!normalizeSnapshot(snapshot, folderPath)) { reportCacheProblem('damaged'); return; }
		await writeIndexedDbSnapshot(snapshot);
	} catch {
		if (!reminderCacheHealth.getSnapshot()) reportCacheProblem('unavailable');
	}
}

export async function clearCachedReminderSnapshots(): Promise<boolean> {
	cacheGeneration += 1;
	return deleteCacheDatabase();
}

/** Rebuild only the current known read-cache stores. Never erase an unknown format. */
export async function rebuildCachedReminderSnapshot(folderPath: string): Promise<boolean> {
	cacheGeneration += 1;
	try {
		const sessionCurrent = capturePwaSession();
		const generation = cacheGeneration;
		const database = await openCacheDatabase();
		try {
			if (!sessionCurrent() || generation !== cacheGeneration) return false;
			await new Promise<void>((resolve, reject) => {
				const transaction = database.transaction([CACHE_STORE_NAME, FRESHNESS_STORE_NAME], 'readwrite');
				transaction.objectStore(CACHE_STORE_NAME).delete(folderPath);
				transaction.objectStore(FRESHNESS_STORE_NAME).delete(folderPath);
				transaction.oncomplete = () => resolve();
				transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Could not rebuild offline cache'));
			});
		} finally { database.close(); }
		reportCacheProblem(null);
		return true;
	} catch { if (!reminderCacheHealth.getSnapshot()) reportCacheProblem('unavailable'); return false; }
}

/** Persist a successful revalidation without cloning or rewriting reminder contents. */
export async function refreshCachedReminderSnapshot(folderPath: string, savedAt: number, etag?: string): Promise<void> {
	if (!etag) return;
	const sessionCurrent = capturePwaSession();
	const generation = cacheGeneration;
	try {
		const database = await openCacheDatabase();
		try {
			if (!sessionCurrent() || generation !== cacheGeneration) return;
			await new Promise<void>((resolve, reject) => {
				const transaction = database.transaction(FRESHNESS_STORE_NAME, 'readwrite');
				transaction.objectStore(FRESHNESS_STORE_NAME).put({ folderPath, savedAt, etag } satisfies CacheFreshness);
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error ?? new Error('Could not refresh reminder cache'));
				transaction.onabort = () => reject(transaction.error ?? new Error('Reminder cache refresh was aborted'));
			});
		} finally {
			database.close();
		}
	} catch {
		if (!reminderCacheHealth.getSnapshot()) reportCacheProblem('unavailable');
	}
}

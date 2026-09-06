import { capturePwaSession } from './session-generation';
import type { CachedReminderSnapshot, ReminderRecord } from './types';

const CACHE_DATABASE_NAME = 'crate-reminders';
const CACHE_DATABASE_VERSION = 2;
const CACHE_STORE_NAME = 'snapshots';
const FRESHNESS_STORE_NAME = 'freshness';
let cacheGeneration = 0;

interface CacheFreshness {
	folderPath: string;
	savedAt: number;
	etag: string;
}

function normalizeSnapshot(value: unknown, folderPath: string): CachedReminderSnapshot | null {
	if (!value || typeof value !== 'object') return null;
	const snapshot = value as Partial<CachedReminderSnapshot>;
	if (
		snapshot.folderPath !== folderPath
		|| !Array.isArray(snapshot.reminders)
		|| !Array.isArray(snapshot.projects)
		|| typeof snapshot.savedAt !== 'number'
	) {
		return null;
	}

	return {
		folderPath,
		reminders: snapshot.reminders,
		projects: snapshot.projects.filter((project): project is string => typeof project === 'string'),
		savedAt: snapshot.savedAt,
		etag: typeof snapshot.etag === 'string' ? snapshot.etag : undefined,
	};
}

function openCacheDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		if (typeof indexedDB === 'undefined') {
			reject(new Error('IndexedDB is unavailable'));
			return;
		}

		const request = indexedDB.open(CACHE_DATABASE_NAME, CACHE_DATABASE_VERSION);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(CACHE_STORE_NAME)) {
				request.result.createObjectStore(CACHE_STORE_NAME, { keyPath: 'folderPath' });
			}
			if (!request.result.objectStoreNames.contains(FRESHNESS_STORE_NAME)) {
				request.result.createObjectStore(FRESHNESS_STORE_NAME, { keyPath: 'folderPath' });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('Could not open reminder cache'));
	});
}

async function readIndexedDbSnapshot(folderPath: string): Promise<CachedReminderSnapshot | null> {
	const database = await openCacheDatabase();
	try {
		return await new Promise((resolve, reject) => {
			const transaction = database.transaction([CACHE_STORE_NAME, FRESHNESS_STORE_NAME], 'readonly');
			const request = transaction.objectStore(CACHE_STORE_NAME).get(folderPath);
			const freshnessRequest = transaction.objectStore(FRESHNESS_STORE_NAME).get(folderPath);
			transaction.oncomplete = () => {
				const snapshot = normalizeSnapshot(request.result, folderPath);
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
	const database = await openCacheDatabase();
	try {
		if (!sessionCurrent() || generation !== cacheGeneration) return;
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction([CACHE_STORE_NAME, FRESHNESS_STORE_NAME], 'readwrite');
			transaction.objectStore(CACHE_STORE_NAME).put(snapshot);
			transaction.objectStore(FRESHNESS_STORE_NAME).delete(snapshot.folderPath);
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error ?? new Error('Could not write reminder cache'));
			transaction.onabort = () => reject(transaction.error ?? new Error('Reminder cache write was aborted'));
		});
	} finally {
		database.close();
	}
}

export async function loadCachedReminderSnapshot(folderPath: string): Promise<CachedReminderSnapshot | null> {
	try {
		return await readIndexedDbSnapshot(folderPath);
	} catch {
		return null;
	}
}

export async function saveCachedReminderSnapshot(
	folderPath: string,
	reminders: ReminderRecord[],
	projects: string[],
	savedAt = Date.now(),
	etag?: string,
): Promise<void> {
	const snapshot: CachedReminderSnapshot = { folderPath, reminders, projects, savedAt, etag };
	try {
		await writeIndexedDbSnapshot(snapshot);
	} catch {
		// Offline caching is best effort.
	}
}

export async function clearCachedReminderSnapshots(): Promise<void> {
	cacheGeneration += 1;
	try {
		const database = await openCacheDatabase();
		try {
			await new Promise<void>((resolve, reject) => {
				const transaction = database.transaction([CACHE_STORE_NAME, FRESHNESS_STORE_NAME], 'readwrite');
				transaction.objectStore(CACHE_STORE_NAME).clear();
				transaction.objectStore(FRESHNESS_STORE_NAME).clear();
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error ?? new Error('Could not clear reminder cache'));
			});
		} finally {
			database.close();
		}
	} catch {
		// Offline caching is best effort.
	}
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
		// Offline caching is best effort.
	}
}

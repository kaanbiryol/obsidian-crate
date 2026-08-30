import type { CachedReminderSnapshot, ReminderRecord } from './types';

export const REMINDERS_CACHE_KEY = 'crate-reminders-cache-v1';

const CACHE_DATABASE_NAME = 'crate-reminders';
const CACHE_DATABASE_VERSION = 1;
const CACHE_STORE_NAME = 'snapshots';

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
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('Could not open reminder cache'));
	});
}

async function readIndexedDbSnapshot(folderPath: string): Promise<CachedReminderSnapshot | null> {
	const database = await openCacheDatabase();
	try {
		return await new Promise((resolve, reject) => {
			const transaction = database.transaction(CACHE_STORE_NAME, 'readonly');
			const request = transaction.objectStore(CACHE_STORE_NAME).get(folderPath);
			request.onsuccess = () => resolve(normalizeSnapshot(request.result, folderPath));
			request.onerror = () => reject(request.error ?? new Error('Could not read reminder cache'));
		});
	} finally {
		database.close();
	}
}

async function writeIndexedDbSnapshot(snapshot: CachedReminderSnapshot): Promise<void> {
	const database = await openCacheDatabase();
	try {
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction(CACHE_STORE_NAME, 'readwrite');
			transaction.objectStore(CACHE_STORE_NAME).put(snapshot);
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error ?? new Error('Could not write reminder cache'));
			transaction.onabort = () => reject(transaction.error ?? new Error('Reminder cache write was aborted'));
		});
	} finally {
		database.close();
	}
}

function readLegacySnapshot(folderPath: string): CachedReminderSnapshot | null {
	try {
		const raw = localStorage.getItem(REMINDERS_CACHE_KEY);
		return raw ? normalizeSnapshot(JSON.parse(raw), folderPath) : null;
	} catch {
		return null;
	}
}

export async function loadCachedReminderSnapshot(folderPath: string): Promise<CachedReminderSnapshot | null> {
	try {
		const snapshot = await readIndexedDbSnapshot(folderPath);
		if (snapshot) return snapshot;
	} catch {
		// Fall through to the legacy cache for browsers that block IndexedDB.
	}

	const legacySnapshot = readLegacySnapshot(folderPath);
	if (!legacySnapshot) return null;

	try {
		await writeIndexedDbSnapshot(legacySnapshot);
		localStorage.removeItem(REMINDERS_CACHE_KEY);
	} catch {
		// Keep the legacy value as a fallback when migration is unavailable.
	}
	return legacySnapshot;
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
		localStorage.removeItem(REMINDERS_CACHE_KEY);
		return;
	} catch {
		// IndexedDB can be unavailable in private or restricted browsing contexts.
	}

	try {
		localStorage.setItem(REMINDERS_CACHE_KEY, JSON.stringify(snapshot));
	} catch {
		// Offline caching is best effort.
	}
}

export async function clearCachedReminderSnapshots(): Promise<void> {
	try {
		localStorage.removeItem(REMINDERS_CACHE_KEY);
	} catch {
		// Storage may be unavailable in restricted contexts.
	}

	try {
		const database = await openCacheDatabase();
		try {
			await new Promise<void>((resolve, reject) => {
				const transaction = database.transaction(CACHE_STORE_NAME, 'readwrite');
				transaction.objectStore(CACHE_STORE_NAME).clear();
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

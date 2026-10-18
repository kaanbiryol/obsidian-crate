import { wrap, type IDBPDatabase } from 'idb';

const CACHE_DATABASE_NAME = 'crate-reminders';
export const CACHE_STORE_NAME = 'snapshots';
export const FRESHNESS_STORE_NAME = 'freshness';
/** One record per note, keyed by [folderPath, path]. */
export const NOTES_STORE_NAME = 'notes';
const CACHE_DATABASE_VERSION = 1;
const OPEN_TIMEOUT_MS = 3_000;

export type CacheProblem = 'blocked' | 'unsupported' | 'damaged' | 'unavailable' | null;
let problem: CacheProblem = null;
const listeners = new Set<() => void>();
export const reminderCacheHealth = {
	getSnapshot: () => problem,
	subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
export function reportCacheProblem(next: CacheProblem): void {
	if (next === problem) return;
	problem = next;
	for (const listener of listeners) listener();
}

function supportedStores(database: IDBDatabase, transaction: IDBTransaction): boolean {
	const names = Array.from(database.objectStoreNames);
	const keyPath = (name: string) => JSON.stringify(transaction.objectStore(name).keyPath);
	return names.length === 3 && [CACHE_STORE_NAME, FRESHNESS_STORE_NAME, NOTES_STORE_NAME].every(name => names.includes(name))
		&& names.every(name => !transaction.objectStore(name).autoIncrement)
		&& keyPath(CACHE_STORE_NAME) === '"folderPath"' && keyPath(FRESHNESS_STORE_NAME) === '"folderPath"'
		&& keyPath(NOTES_STORE_NAME) === '["folderPath","path"]';
}

/** A blocked/failed upgrade must not hold bootstrap or a confirmed mutation open. */
export function openCacheDatabase(): Promise<IDBPDatabase> {
	return new Promise((resolve, reject) => {
		let abandoned = false;
		const fail = (reason: CacheProblem, error?: unknown) => {
			if (abandoned) return;
			abandoned = true;
			clearTimeout(timer);
			reportCacheProblem(reason);
			reject(error instanceof Error ? error : new Error('Offline cache is unavailable'));
		};
		const timer = setTimeout(() => fail('blocked'), OPEN_TIMEOUT_MS);
		let request: IDBOpenDBRequest;
		try { request = indexedDB.open(CACHE_DATABASE_NAME, CACHE_DATABASE_VERSION); }
		catch (error) { fail('unavailable', error); return; }
		request.onblocked = () => fail('blocked');
		request.onupgradeneeded = event => {
			try {
				if (abandoned) { request.transaction?.abort(); return; }
				const database = request.result;
				if (event.oldVersion === 0) {
					database.createObjectStore(CACHE_STORE_NAME, { keyPath: 'folderPath' });
					database.createObjectStore(FRESHNESS_STORE_NAME, { keyPath: 'folderPath' });
					database.createObjectStore(NOTES_STORE_NAME, { keyPath: ['folderPath', 'path'] });
				} else {
					fail('unsupported');
					request.transaction?.abort();
				}
			} catch (error) {
				fail('unavailable', error);
				try { request.transaction?.abort(); } catch { /* The upgrade may already have aborted. */ }
			}
		};
		request.onsuccess = () => {
			const database = request.result;
			if (abandoned) { database.close(); return; }
			try {
				if (!supportedStores(database, database.transaction(Array.from(database.objectStoreNames), 'readonly'))) {
					database.close(); fail('unsupported'); return;
				}
			} catch (error) { database.close(); fail('unsupported', error); return; }
			clearTimeout(timer);
			database.onversionchange = () => database.close();
			// Keep native open/upgrade fencing above; idb handles transaction promises.
			resolve(wrap(database));
		};
		request.onerror = () => fail(request.error?.name === 'VersionError' ? 'unsupported' : 'unavailable', request.error);
	});
}

/** Explicit logout deletes private cache data; a blocked delete remains queued by IndexedDB. */
export function deleteCacheDatabase(): Promise<boolean> {
	return new Promise(resolve => {
		let finished = false;
		const finish = (success: boolean) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			reportCacheProblem(success ? null : 'blocked');
			resolve(success);
		};
		const timer = setTimeout(() => finish(false), OPEN_TIMEOUT_MS);
		try {
			const request = indexedDB.deleteDatabase(CACHE_DATABASE_NAME);
			request.onblocked = () => finish(false);
			request.onsuccess = () => finish(true);
			request.onerror = () => finish(false);
		} catch { finish(false); }
	});
}

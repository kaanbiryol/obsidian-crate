const CACHE_DATABASE_NAME = 'crate-reminders';
export const CACHE_STORE_NAME = 'snapshots';
export const FRESHNESS_STORE_NAME = 'freshness';
const CACHE_DATABASE_VERSION = 2;
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

function supportedStores(database: IDBDatabase, transaction: IDBTransaction, version: number): boolean {
	const names = Array.from(database.objectStoreNames);
	return names.includes(CACHE_STORE_NAME) && names.every(name => name === CACHE_STORE_NAME || name === FRESHNESS_STORE_NAME)
		&& names.every(name => transaction.objectStore(name).keyPath === 'folderPath' && !transaction.objectStore(name).autoIncrement)
		&& (version === 1 || names.includes(FRESHNESS_STORE_NAME));
}

/** A blocked/failed upgrade must not hold bootstrap or a confirmed mutation open. */
export function openCacheDatabase(): Promise<IDBDatabase> {
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
			if (abandoned) { request.transaction?.abort(); return; }
			const database = request.result;
			if (event.oldVersion === 0) {
				database.createObjectStore(CACHE_STORE_NAME, { keyPath: 'folderPath' });
				database.createObjectStore(FRESHNESS_STORE_NAME, { keyPath: 'folderPath' });
			} else if (event.oldVersion === 1 && request.transaction && supportedStores(database, request.transaction, 1)) {
				// Add only disposable freshness metadata. Existing snapshots and
				// their bytes survive an interrupted migration transaction.
				if (!database.objectStoreNames.contains(FRESHNESS_STORE_NAME)) database.createObjectStore(FRESHNESS_STORE_NAME, { keyPath: 'folderPath' });
			} else {
				fail('unsupported');
				request.transaction?.abort();
			}
		};
		request.onsuccess = () => {
			const database = request.result;
			if (abandoned) { database.close(); return; }
			try {
				if (!supportedStores(database, database.transaction(Array.from(database.objectStoreNames), 'readonly'), database.version)) {
					database.close(); fail('unsupported'); return;
				}
			} catch (error) { database.close(); fail('unsupported', error); return; }
			clearTimeout(timer);
			database.onversionchange = () => database.close();
			resolve(database);
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

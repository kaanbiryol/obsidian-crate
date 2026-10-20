import type { IDBPDatabase } from 'idb';
import { openVersionOneDatabase } from '../../storage/single-store-database';

const CACHE_DATABASE_NAME = 'crate-reminders';
export const CACHE_STORE_NAME = 'snapshots';
export const FRESHNESS_STORE_NAME = 'freshness';
/** One record per note, keyed by [folderPath, path]. */
export const NOTES_STORE_NAME = 'notes';
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

/** A blocked/failed upgrade must not hold bootstrap or a confirmed mutation open. */
export function openCacheDatabase(): Promise<IDBPDatabase> {
	return openVersionOneDatabase(CACHE_DATABASE_NAME, [
		{ name: CACHE_STORE_NAME, keyPath: 'folderPath' },
		{ name: FRESHNESS_STORE_NAME, keyPath: 'folderPath' },
		{ name: NOTES_STORE_NAME, keyPath: ['folderPath', 'path'] },
	], {
		fail: (reason, cause) => {
			reportCacheProblem(reason);
			return cause instanceof Error ? cause : new Error('Offline cache is unavailable');
		},
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

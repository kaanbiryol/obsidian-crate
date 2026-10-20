import type { DBSchema, IDBPDatabase, StoreNames } from 'idb';

/** Recheck authority inside an active IDB transaction and roll back even when
 * reading session storage throws. A queued clear must not erase newer work. */
export async function clearSessionStore<DB extends DBSchema>(database: IDBPDatabase<DB>, store: StoreNames<DB>, isCurrent: () => boolean): Promise<void> {
	const tx = database.transaction(store, 'readwrite');
	let committed = false;
	try {
		await tx.store.count();
		if (!isCurrent()) return;
		await tx.store.clear();
		if (!isCurrent()) return;
		await tx.done;
		committed = true;
	} finally {
		if (!committed) {
			try { tx.abort(); } catch { /* A failed transaction may already have aborted. */ }
			await tx.done.catch(() => {});
		}
	}
}

import type { DBSchema, IDBPDatabase, StoreNames } from 'idb';
import { abortTransaction } from './abort-transaction';

/** Recheck authority inside an active IDB transaction and roll back even when
 * reading session storage throws. A queued clear must not erase newer work.
 * Resolves to whether the clear committed. */
export async function clearSessionStore<DB extends DBSchema>(database: IDBPDatabase<DB>, store: StoreNames<DB>, isCurrent: () => boolean): Promise<boolean> {
	const tx = database.transaction(store, 'readwrite');
	let committed = false;
	try {
		await tx.store.count();
		if (!isCurrent()) return false;
		await tx.store.clear();
		if (!isCurrent()) return false;
		await tx.done;
		committed = true;
		return true;
	} finally {
		if (!committed) await abortTransaction(tx);
	}
}

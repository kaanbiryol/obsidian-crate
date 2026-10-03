import { wrap, type DBSchema, type IDBPDatabase, type StoreNames } from 'idb';

const OPEN_TIMEOUT_MS = 3_000;
const BLOCKED_MESSAGE = 'Encrypted browser storage is blocked. Close other Crate tabs and retry.';
const UNSUPPORTED_MESSAGE = 'Encrypted browser storage uses an unsupported format. Update Crate before retrying.';

/** Both private databases use one version-1 store with explicit string keys.
 * Never reset unknown data or let an abandoned open perform a late upgrade. */
export function openEncryptedDatabase<DB extends DBSchema>(name: string, store: StoreNames<DB> & string): Promise<IDBPDatabase<DB>> {
	return new Promise((resolve, reject) => {
		let abandoned = false;
		let abortUpgrade = () => {};
		const fail = (message: string) => {
			if (abandoned) return;
			abandoned = true;
			clearTimeout(timer);
			abortUpgrade();
			reject(new Error(message));
		};
		const timer = setTimeout(() => fail(BLOCKED_MESSAGE), OPEN_TIMEOUT_MS);
		let request: IDBOpenDBRequest;
		try { request = indexedDB.open(name, 1); }
		catch { fail('Encrypted browser storage is unavailable. Check browser storage permissions and retry.'); return; }
		abortUpgrade = () => { try { request.transaction?.abort(); } catch { /* Already aborted. */ } };
		request.onblocked = () => fail(BLOCKED_MESSAGE);
		request.onupgradeneeded = event => {
			if (abandoned) { abortUpgrade(); return; }
			try {
				if (event.oldVersion !== 0) { fail(UNSUPPORTED_MESSAGE); return; }
				request.result.createObjectStore(store);
			} catch { fail(UNSUPPORTED_MESSAGE); }
		};
		request.onsuccess = () => {
			const database = request.result;
			if (abandoned) { database.close(); return; }
			try {
				if (database.objectStoreNames.length !== 1 || !database.objectStoreNames.contains(store)) throw new Error();
				const objectStore = database.transaction(store).objectStore(store);
				if (objectStore.keyPath !== null || objectStore.autoIncrement) throw new Error();
			} catch { database.close(); fail(UNSUPPORTED_MESSAGE); return; }
			clearTimeout(timer);
			database.onversionchange = () => database.close();
			resolve(wrap(database) as IDBPDatabase<DB>);
		};
		request.onerror = () => fail(request.error?.name === 'VersionError' ? UNSUPPORTED_MESSAGE
			: 'Encrypted browser storage is unavailable. Check browser storage permissions and retry.');
	});
}

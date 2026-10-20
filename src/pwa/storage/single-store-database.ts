import { wrap, type DBSchema, type IDBPDatabase, type StoreNames } from 'idb';

const OPEN_TIMEOUT_MS = 3_000;

interface SingleStoreDatabaseOptions {
	messages: { blocked: string; unsupported: string; unavailable: string };
	onClose?: () => void;
}

/** Open an owned version-one store with explicit string keys, preserving unknown
 * formats and fencing upgrades/connections that finish after the open failed. */
export function openSingleStoreDatabase<DB extends DBSchema>(name: string, store: StoreNames<DB> & string, options: SingleStoreDatabaseOptions): Promise<IDBPDatabase<DB>> {
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
		const timer = setTimeout(() => fail(options.messages.blocked), OPEN_TIMEOUT_MS);
		let request: IDBOpenDBRequest;
		try { request = indexedDB.open(name, 1); }
		catch { fail(options.messages.unavailable); return; }
		abortUpgrade = () => { try { request.transaction?.abort(); } catch { /* Already aborted. */ } };
		request.onblocked = () => fail(options.messages.blocked);
		request.onupgradeneeded = event => {
			if (abandoned) { abortUpgrade(); return; }
			try {
				if (event.oldVersion !== 0) { fail(options.messages.unsupported); return; }
				request.result.createObjectStore(store);
			} catch { fail(options.messages.unsupported); }
		};
		request.onsuccess = () => {
			const database = request.result;
			if (abandoned) { database.close(); return; }
			try {
				if (database.objectStoreNames.length !== 1 || !database.objectStoreNames.contains(store)) throw new Error();
				const objectStore = database.transaction(store).objectStore(store);
				if (objectStore.keyPath !== null || objectStore.autoIncrement) throw new Error();
			} catch { database.close(); fail(options.messages.unsupported); return; }
			clearTimeout(timer);
			database.onversionchange = () => { database.close(); options.onClose?.(); };
			database.onclose = () => options.onClose?.();
			resolve(wrap(database) as IDBPDatabase<DB>);
		};
		request.onerror = () => fail(request.error?.name === 'VersionError' ? options.messages.unsupported : options.messages.unavailable);
	});
}

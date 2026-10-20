import { wrap, type DBSchema, type IDBPDatabase, type StoreNames } from 'idb';

const OPEN_TIMEOUT_MS = 3_000;

type DatabaseOpenFailure = 'blocked' | 'unsupported' | 'unavailable';

interface StoreSpec {
	name: string;
	/** Omitted for stores with explicit string keys. */
	keyPath?: string | string[];
}

interface VersionOneDatabaseOptions {
	/** Builds the rejection for a failed open; callers may also record the reason. */
	fail: (reason: DatabaseOpenFailure, cause?: unknown) => Error;
	onClose?: () => void;
}

function hasExactStores(database: IDBDatabase, stores: StoreSpec[]): boolean {
	if (database.objectStoreNames.length !== stores.length || stores.some(store => !database.objectStoreNames.contains(store.name))) return false;
	const transaction = database.transaction(stores.map(store => store.name), 'readonly');
	return stores.every(store => {
		const objectStore = transaction.objectStore(store.name);
		return !objectStore.autoIncrement && JSON.stringify(objectStore.keyPath) === JSON.stringify(store.keyPath ?? null);
	});
}

/** Open an owned version-one database with exactly these stores, preserving
 * unknown formats and fencing upgrades/connections that finish after the open
 * failed. A blocked or failed upgrade never holds its caller open. */
export function openVersionOneDatabase<DB = unknown>(name: string, stores: StoreSpec[], options: VersionOneDatabaseOptions): Promise<IDBPDatabase<DB>> {
	return new Promise((resolve, reject) => {
		let abandoned = false;
		let abortUpgrade = () => {};
		const fail = (reason: DatabaseOpenFailure, cause?: unknown) => {
			if (abandoned) return;
			abandoned = true;
			clearTimeout(timer);
			abortUpgrade();
			reject(options.fail(reason, cause));
		};
		const timer = setTimeout(() => fail('blocked'), OPEN_TIMEOUT_MS);
		let request: IDBOpenDBRequest;
		try { request = indexedDB.open(name, 1); }
		catch (error) { fail('unavailable', error); return; }
		abortUpgrade = () => { try { request.transaction?.abort(); } catch { /* Already aborted. */ } };
		request.onblocked = () => fail('blocked');
		request.onupgradeneeded = event => {
			if (abandoned) { abortUpgrade(); return; }
			if (event.oldVersion !== 0) { fail('unsupported'); return; }
			try {
				for (const store of stores) request.result.createObjectStore(store.name, store.keyPath === undefined ? undefined : { keyPath: store.keyPath });
			} catch (error) { fail('unavailable', error); }
		};
		request.onsuccess = () => {
			const database = request.result;
			if (abandoned) { database.close(); return; }
			try {
				if (!hasExactStores(database, stores)) { database.close(); fail('unsupported'); return; }
			} catch (error) { database.close(); fail('unsupported', error); return; }
			clearTimeout(timer);
			database.onversionchange = () => { database.close(); options.onClose?.(); };
			database.onclose = () => options.onClose?.();
			resolve(wrap(database) as IDBPDatabase<DB>);
		};
		request.onerror = () => fail(request.error?.name === 'VersionError' ? 'unsupported' : 'unavailable', request.error);
	});
}

interface SingleStoreDatabaseOptions {
	messages: Record<DatabaseOpenFailure, string>;
	onClose?: () => void;
}

/** A version-one database with one store of explicit string keys. */
export function openSingleStoreDatabase<DB extends DBSchema>(name: string, store: StoreNames<DB> & string, options: SingleStoreDatabaseOptions): Promise<IDBPDatabase<DB>> {
	return openVersionOneDatabase<DB>(name, [{ name: store }], {
		fail: reason => new Error(options.messages[reason]),
		onClose: options.onClose,
	});
}

import { wrap, type DBSchema, type IDBPDatabase, type StoreNames } from 'idb';

const OPEN_TIMEOUT_MS = 3_000;

type DatabaseOpenFailure = 'blocked' | 'unsupported' | 'unavailable';

interface StoreSpec {
	name: string;
	/** Omitted for stores with explicit string keys. */
	keyPath?: string | string[];
}

interface VersionedDatabaseOptions {
	/** Builds the rejection for a failed open; callers may also record the reason. */
	fail: (reason: DatabaseOpenFailure, cause?: unknown) => Error;
	onClose?: () => void;
}

/** One released database version: its exact store layout and, from version 2, the step that
 * turns the previous version into it. Released entries never change; append a new one. */
export interface DatabaseVersion {
	stores: StoreSpec[];
	/** Runs inside the upgrade transaction, so a thrown error or a failed request aborts every
	 * step and leaves the previous version's data untouched. Queue requests on `transaction`
	 * synchronously or from its own callbacks; awaiting anything else ends the transaction. */
	upgrade?: (database: IDBDatabase, transaction: IDBTransaction) => void;
}

function matchesStores(names: DOMStringList, objectStore: (name: string) => IDBObjectStore, stores: StoreSpec[]): boolean {
	if (names.length !== stores.length || stores.some(store => !names.contains(store.name))) return false;
	return stores.every(store => {
		const existing = objectStore(store.name);
		return !existing.autoIncrement && JSON.stringify(existing.keyPath) === JSON.stringify(store.keyPath ?? null);
	});
}

function hasExactStores(database: IDBDatabase, stores: StoreSpec[]): boolean {
	if (database.objectStoreNames.length !== stores.length) return false;
	const transaction = database.transaction(stores.map(store => store.name), 'readonly');
	return matchesStores(database.objectStoreNames, name => transaction.objectStore(name), stores);
}

/** Open an owned database at the newest of `versions` (version n is `versions[n - 1]`). A new
 * database gets the newest layout. An older one upgrades through each registered step, but only
 * when its stores match the layout its version was released with. Unknown layouts, newer
 * versions and versions without a step are preserved and reported as unsupported. Upgrades and
 * connections that finish after the open failed are fenced, and a blocked or failed upgrade
 * never holds its caller open. */
export function openVersionedDatabase<DB = unknown>(name: string, versions: readonly DatabaseVersion[], options: VersionedDatabaseOptions): Promise<IDBPDatabase<DB>> {
	const target = versions.length;
	const latest = versions.at(-1);
	if (!latest) throw new Error('A database needs at least one version.');
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
		try { request = indexedDB.open(name, target); }
		catch (error) { fail('unavailable', error); return; }
		abortUpgrade = () => { try { request.transaction?.abort(); } catch { /* Already aborted. */ } };
		request.onblocked = () => fail('blocked');
		request.onupgradeneeded = event => {
			if (abandoned) { abortUpgrade(); return; }
			const database = request.result;
			const transaction = request.transaction;
			try {
				if (event.oldVersion === 0) {
					for (const store of latest.stores) database.createObjectStore(store.name, store.keyPath === undefined ? undefined : { keyPath: store.keyPath });
					return;
				}
				const released = versions[event.oldVersion - 1];
				const steps = versions.slice(event.oldVersion);
				if (!transaction || !released || steps.some(step => !step.upgrade)
					|| !matchesStores(database.objectStoreNames, store => transaction.objectStore(store), released.stores)) {
					fail('unsupported');
					return;
				}
				for (const step of steps) step.upgrade?.(database, transaction);
			} catch (error) { fail('unavailable', error); }
		};
		request.onsuccess = () => {
			const database = request.result;
			if (abandoned) { database.close(); return; }
			try {
				if (!hasExactStores(database, latest.stores)) { database.close(); fail('unsupported'); return; }
			} catch (error) { database.close(); fail('unsupported', error); return; }
			clearTimeout(timer);
			database.onversionchange = () => { database.close(); options.onClose?.(); };
			database.onclose = () => options.onClose?.();
			resolve(wrap(database) as IDBPDatabase<DB>);
		};
		// An aborted upgrade also lands here; the database keeps its previous version and data.
		request.onerror = () => fail(request.error?.name === 'VersionError' ? 'unsupported' : 'unavailable', request.error);
	});
}

interface SingleStoreDatabaseOptions {
	messages: Record<DatabaseOpenFailure, string>;
	onClose?: () => void;
}

/** A version-one database with one store of explicit string keys. Call `openVersionedDatabase`
 * directly once its layout needs a second version. */
export function openSingleStoreDatabase<DB extends DBSchema>(name: string, store: StoreNames<DB> & string, options: SingleStoreDatabaseOptions): Promise<IDBPDatabase<DB>> {
	return openVersionedDatabase<DB>(name, [{ stores: [{ name: store }] }], {
		fail: reason => new Error(options.messages[reason]),
		onClose: options.onClose,
	});
}

import type { DBSchema, IDBPDatabase, StoreNames } from 'idb';
import { openSingleStoreDatabase } from './single-store-database';

export function openEncryptedDatabase<DB extends DBSchema>(name: string, store: StoreNames<DB> & string): Promise<IDBPDatabase<DB>> {
	return openSingleStoreDatabase<DB>(name, store, { messages: {
		blocked: 'Encrypted browser storage is blocked. Close other Crate tabs and retry.',
		unsupported: 'Encrypted browser storage uses an unsupported format. Update Crate before retrying.',
		unavailable: 'Encrypted browser storage is unavailable. Check browser storage permissions and retry.',
	} });
}

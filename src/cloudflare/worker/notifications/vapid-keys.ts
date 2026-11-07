import {
	deserializeVapidKeys,
	generateVapidKeys,
	serializeVapidKeys,
} from 'web-push-browser';
import { queryRows } from '../d1/db';

interface SerializedVapidKeys {
	publicKey: string;
	privateKey: string;
}

export async function getOrCreateVapidKeys(db: D1Database): Promise<SerializedVapidKeys> {
	const readPersistedKeys = async (): Promise<SerializedVapidKeys | null> => {
		const rows = await queryRows<{ public_key: string; private_key: string }>(
			db.prepare('SELECT public_key, private_key FROM vapid_keys WHERE id = 1'),
		);
		const row = rows[0];
		return row ? { publicKey: row.public_key, privateKey: row.private_key } : null;
	};

	const existingKeys = await readPersistedKeys();
	if (existingKeys) return existingKeys;

	const keyPair = await generateVapidKeys();
	const serialized = await serializeVapidKeys(keyPair);
	await db.prepare(
		'INSERT OR IGNORE INTO vapid_keys (id, public_key, private_key) VALUES (1, ?, ?)',
	).bind(serialized.publicKey, serialized.privateKey).run();

	const persistedKeys = await readPersistedKeys();
	if (!persistedKeys) throw new Error('Failed to persist VAPID keys');
	return persistedKeys;
}

// Imported keys are reused by this isolate until the stored key pair changes.
let importedVapidKeys: { id: string; keys: Promise<CryptoKeyPair> } | undefined;

export function importVapidKeys(serialized: SerializedVapidKeys): Promise<CryptoKeyPair> {
	const id = `${serialized.publicKey}.${serialized.privateKey}`;
	if (importedVapidKeys?.id === id) return importedVapidKeys.keys;
	const keys = deserializeVapidKeys(serialized);
	importedVapidKeys = { id, keys };
	keys.catch(() => {
		if (importedVapidKeys?.keys === keys) importedVapidKeys = undefined;
	});
	return keys;
}

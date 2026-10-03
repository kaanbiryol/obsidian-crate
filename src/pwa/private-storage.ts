import type { LocalStateCipher } from '../encryption/local-state';

let cipher: LocalStateCipher | undefined;
let locked = false;
export const privateStorageEnabled = () => !!cipher || locked;

export function requirePrivateStorageUnlock(): void { cipher?.destroy(); cipher = undefined; locked = true; }

export function lockPrivateStorage(): void {
	if (cipher) { cipher.destroy(); cipher = undefined; locked = true; }
}

/** Only after the current session's encryption check accepts unencrypted mode.
 * Leave durable records untouched; old ciphertext still requires its keys. */
export function useUnencryptedStorage(): void {
	cipher?.destroy();
	cipher = undefined;
	locked = false;
}

/** Convert one folder's unsent data in place. setItem either succeeds with the
 * complete ciphertext or preserves the old bytes on quota failure. Never clear
 * drafts or pending commands as part of enabling encryption. */
export function unlockPrivateStorage(next: LocalStateCipher, folderPath: string, persistent: Storage, session: Storage): void {
	const folder = encodeURIComponent(folderPath);
	for (const [storage, accepts] of [
		[persistent, (key: string) => key.startsWith('crate-reminder-outbox:') && key.split(':')[3] === folder],
		[session, (key: string) => key.startsWith(`crate-reminder-draft:${folder}:`)],
	] as const) {
		const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => key !== null && accepts(key));
		for (const key of keys) {
			const value = storage.getItem(key);
			if (value !== null && !value.startsWith('crate-local-e2ee-')) storage.setItem(key, next.seal(value, key));
		}
	}
	if (cipher !== next) cipher?.destroy();
	cipher = next;
	locked = false;
}

export function sealPrivateValue(value: string, key: string): string {
	if (locked) throw new Error('Unlock Crate before saving private browser data');
	return cipher ? cipher.seal(value, key) : value;
}

export function openPrivateValue(value: string, key: string): string {
	if (locked) throw new Error('Unlock Crate to recover private browser data');
	if (cipher) return cipher.open(value, key);
	if (value.startsWith('crate-local-e2ee-')) throw new Error('Unlock Crate to recover private browser data');
	return value;
}

/** Unknown/damaged ciphertext remains byte-for-byte available to quarantine. */
export function privateStorage(storage: Storage): Storage {
	return {
		get length() { return storage.length; },
		key: index => storage.key(index),
		getItem(key) {
			const raw = storage.getItem(key);
			if (raw === null) return null;
			try { return openPrivateValue(raw, key); }
			catch { return raw; }
		},
		setItem: (key, value) => storage.setItem(key, sealPrivateValue(value, key)),
		removeItem: key => storage.removeItem(key),
		clear: () => storage.clear(),
	};
}

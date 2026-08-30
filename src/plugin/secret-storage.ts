/**
 * Wrapper around Obsidian's SecretStorage API (v1.11.4+)
 *
 * app.secretStorage provides cross-platform secure credential storage
 * using the OS keychain on desktop. The API is synchronous.
 * There is no delete method — setting an empty string is the convention.
 */

import type { App } from 'obsidian';
import { SECRET_KEYS, type SecretKey } from './types';

export class SecretStorageService {
	private secretStorage: App['secretStorage'];

	constructor(
		app: App,
		private readonly authScopeProvider: () => string | null = () => null,
	) {
		if (!app.secretStorage) {
			throw new Error('Obsidian secret storage is unavailable on this platform or app version');
		}
		this.secretStorage = app.secretStorage;
	}

	get(key: SecretKey): string | null {
		const value = this.secretStorage.getSecret(this.storageId(key));
		return value || null;
	}

	set(key: SecretKey, value: string): void {
		this.secretStorage.setSecret(this.storageId(key), value);
	}

	delete(key: SecretKey): void {
		this.secretStorage.setSecret(this.storageId(key), '');
	}

	has(key: SecretKey): boolean {
		return !!this.get(key);
	}

	private storageId(key: SecretKey): string {
		if (key !== SECRET_KEYS.AUTH_TOKEN) {
			return key;
		}

		const scope = this.authScopeProvider()?.trim();
		return scope ? `crate-${hashSecretScope(scope)}-auth-token` : key;
	}
}

function hashSecretScope(value: string): string {
	let hash = 0xcbf29ce484222325n;
	for (const byte of new TextEncoder().encode(value)) {
		hash ^= BigInt(byte);
		hash = BigInt.asUintN(64, hash * 0x100000001b3n);
	}
	return hash.toString(16).padStart(16, '0');
}

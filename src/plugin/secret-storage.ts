/**
 * Wrapper around Obsidian's SecretStorage API (v1.11.4+)
 *
 * app.secretStorage provides cross-platform secure credential storage
 * using the OS keychain on desktop. The API is synchronous.
 * There is no delete method — setting an empty string is the convention.
 */

import type { App } from 'obsidian';
import type { SecretKey } from './types';

interface SecretStorage {
	getSecret(id: string): string | null;
	setSecret(id: string, secret: string): void;
	listSecrets(): string[];
}

declare module 'obsidian' {
	interface App {
		secretStorage: SecretStorage;
	}
}

export class SecretStorageService {
	private secretStorage: SecretStorage;

	constructor(app: App) {
		if (!app.secretStorage) {
			throw new Error('Obsidian secret storage is unavailable on this platform or app version');
		}
		this.secretStorage = app.secretStorage;
	}

	get(key: SecretKey): string | null {
		const value = this.secretStorage.getSecret(key);
		return value || null;
	}

	set(key: SecretKey, value: string): void {
		this.secretStorage.setSecret(key, value);
	}

	delete(key: SecretKey): void {
		this.secretStorage.setSecret(key, '');
	}

	has(key: SecretKey): boolean {
		return !!this.get(key);
	}
}

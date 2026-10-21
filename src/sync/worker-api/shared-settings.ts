import { normalizeSharedSettingsValue, type SharedSettings } from '../../protocol/shared-settings';
import { HttpError, type WorkerApiHttpClient } from './http';
import type { EncryptedFiles } from '../encryption/encrypted-files';

export interface VersionedSharedSettings {
	settings: SharedSettings | null;
	settingsVersion: string | null;
}

export class SharedSettingsWorkerApi {
	/** The server's settings as this client last read or wrote them; undefined until known. */
	private seen: VersionedSharedSettings | undefined;

	constructor(private readonly http: WorkerApiHttpClient) {}
	private encryption?: EncryptedFiles;
	setEncryption(encryption: EncryptedFiles): void { this.encryption = encryption; this.seen = undefined; }

	async getSharedSettings(): Promise<VersionedSharedSettings> {
		const result = await this.http.requestJson<{
			settings: SharedSettings | null;
			settingsVersion?: string | null;
		}>('/settings');
		let settings = result.settings;
		if (this.encryption && result.settings !== null) {
			const opened = await this.encryption.openSettings(result.settings);
			settings = opened === null ? null : normalizeSharedSettingsValue(opened);
			if (opened !== null && !settings) throw new Error('Decrypted shared settings are invalid');
		}
		this.seen = { settings, settingsVersion: result.settingsVersion ?? null };
		return { ...this.seen };
	}

	/** The server's settings as this client last read or wrote them, read first when unknown. */
	async getKnownSharedSettings(): Promise<VersionedSharedSettings> {
		return this.seen ? { ...this.seen } : this.getSharedSettings();
	}

	/** Writes against the version this client last saw, so a stale write gets a 409. */
	async putSharedSettings(settings: SharedSettings): Promise<{ success: boolean; settingsVersion: string }> {
		const { settingsVersion } = await this.getKnownSharedSettings();
		return this.writeSharedSettings(settings, settingsVersion);
	}

	/** Stores settings only while the server has none, so it never replaces another device's. */
	async createSharedSettings(settings: SharedSettings): Promise<{ success: boolean; settingsVersion: string }> {
		return this.writeSharedSettings(settings, null);
	}

	private async writeSharedSettings(settings: SharedSettings, expectedVersion: string | null): Promise<{ success: boolean; settingsVersion: string }> {
		try {
			const result = await this.http.requestJson<{ success: boolean; settingsVersion: string }>('/settings', {
				method: 'PUT',
				body: JSON.stringify({ settings: this.encryption ? await this.encryption.sealSettings(settings) : settings, expectedVersion }),
			});
			this.seen = { settings: structuredClone(settings), settingsVersion: result.settingsVersion };
			return result;
		} catch (error) {
			if (error instanceof HttpError && error.status === 409) this.seen = undefined;
			throw error;
		}
	}
}

import type { SharedSettings } from '../../plugin/settings-types';
import { HttpError, type WorkerApiHttpClient } from './http';
import type { EncryptedFiles } from '../encrypted-files';
import { normalizeSharedSettingsValue } from '../shared-settings';

export class SharedSettingsWorkerApi {
	private settingsVersion: string | null | undefined;

	constructor(private readonly http: WorkerApiHttpClient) {}
	private encryption?: EncryptedFiles;
	setEncryption(encryption: EncryptedFiles): void { this.encryption = encryption; this.settingsVersion = undefined; }

	async getSharedSettings(): Promise<{ settings: SharedSettings | null; settingsVersion: string | null }> {
		const result = await this.http.requestJson<{
			settings: SharedSettings | null;
			settingsVersion?: string | null;
		}>('/settings');
		if (this.encryption && result.settings !== null) {
			const opened = await this.encryption.openSettings(result.settings);
			const settings = opened === null ? null : normalizeSharedSettingsValue(opened);
			if (opened !== null && !settings) throw new Error('Decrypted shared settings are invalid');
			this.settingsVersion = result.settingsVersion ?? null;
			return { settings, settingsVersion: this.settingsVersion };
		}
		this.settingsVersion = result.settingsVersion ?? null;
		return { settings: result.settings, settingsVersion: this.settingsVersion };
	}

	async putSharedSettings(settings: SharedSettings): Promise<{ success: boolean; settingsVersion: string }> {
		if (this.settingsVersion === undefined) await this.getSharedSettings();
		try {
			const result = await this.http.requestJson<{ success: boolean; settingsVersion: string }>('/settings', {
				method: 'PUT',
				body: JSON.stringify({ settings: this.encryption ? await this.encryption.sealSettings(settings) : settings, expectedVersion: this.settingsVersion ?? null }),
			});
			this.settingsVersion = result.settingsVersion;
			return result;
		} catch (error) {
			if (error instanceof HttpError && error.status === 409) this.settingsVersion = undefined;
			throw error;
		}
	}
}

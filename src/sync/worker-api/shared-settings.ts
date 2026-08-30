import type { SharedSettings } from '../../plugin/types';
import { HttpError, type WorkerApiHttpClient } from './http';

export class SharedSettingsWorkerApi {
	private settingsVersion: string | null | undefined;

	constructor(private readonly http: WorkerApiHttpClient) {}

	async getSharedSettings(): Promise<{ settings: SharedSettings | null; settingsVersion: string | null }> {
		const result = await this.http.requestJson<{
			settings: SharedSettings | null;
			settingsVersion?: string | null;
		}>('/settings');
		this.settingsVersion = result.settingsVersion ?? null;
		return { settings: result.settings, settingsVersion: this.settingsVersion };
	}

	async putSharedSettings(settings: SharedSettings): Promise<{ success: boolean; settingsVersion: string }> {
		if (this.settingsVersion === undefined) await this.getSharedSettings();
		try {
			const result = await this.http.requestJson<{ success: boolean; settingsVersion: string }>('/settings', {
				method: 'PUT',
				body: JSON.stringify({ settings, expectedVersion: this.settingsVersion ?? null }),
			});
			this.settingsVersion = result.settingsVersion;
			return result;
		} catch (error) {
			if (error instanceof HttpError && error.status === 409) this.settingsVersion = undefined;
			throw error;
		}
	}
}

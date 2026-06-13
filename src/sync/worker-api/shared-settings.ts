import type { SharedSettings } from '../../plugin/types';
import type { WorkerApiHttpClient } from './http';

export class SharedSettingsWorkerApi {
	constructor(private readonly http: WorkerApiHttpClient) {}

	async getSharedSettings(): Promise<{ settings: SharedSettings | null }> {
		return this.http.requestJson<{ settings: SharedSettings | null }>('/settings');
	}

	async putSharedSettings(settings: SharedSettings): Promise<{ success: boolean }> {
		return this.http.requestJson<{ success: boolean }>('/settings', {
			method: 'PUT',
			body: JSON.stringify({ settings }),
		});
	}
}

import type { RegisteredDevice } from '../../plugin/types';
import type { WorkerApiHttpClient } from './http';

export class AuthWorkerApi {
	constructor(private readonly http: WorkerApiHttpClient) {}

	async revokeToken(id: string): Promise<{ success: boolean }> {
		return this.http.requestJson<{ success: boolean }>('/auth/tokens', {
			method: 'DELETE',
			body: JSON.stringify({ id }),
		});
	}

	async revokeCurrentToken(): Promise<{ success: boolean }> {
		return this.http.requestJson<{ success: boolean }>('/auth/session', {
			method: 'DELETE',
		});
	}

	async listTokens(): Promise<{ tokens: RegisteredDevice[] }> {
		return this.http.requestJson<{ tokens: RegisteredDevice[] }>('/auth/tokens');
	}
}

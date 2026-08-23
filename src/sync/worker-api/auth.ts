import type { RegisteredDevice } from '../../plugin/types';
import type { WorkerApiHttpClient } from './http';

export class AuthWorkerApi {
	constructor(private readonly http: WorkerApiHttpClient) {}

	async claimInitialServer(enrollmentTokenHash: string): Promise<{ expiresAt: string }> {
		return this.http.requestJson<{ expiresAt: string }>('/setup/claim', {
			method: 'POST',
			body: JSON.stringify({ enrollmentTokenHash }),
		});
	}

	async authorizeDeviceEnrollment(enrollmentTokenHash: string): Promise<{ expiresAt: string }> {
		return this.http.requestJson<{ expiresAt: string }>('/auth/enrollment', {
			method: 'POST',
			body: JSON.stringify({ enrollmentTokenHash }),
		});
	}

	async enrollDevice(input: {
		enrollmentToken: string;
		deviceTokenHash: string;
		deviceId?: string;
		deviceName?: string;
		platform?: string;
	}): Promise<{ id: string }> {
		return this.http.requestJson<{ id: string }>('/setup/enroll', {
			method: 'POST',
			body: JSON.stringify(input),
		});
	}

	async registerToken(tokenHash: string, device?: {
		deviceId?: string;
		deviceName?: string;
		platform?: string;
	}): Promise<{ id: string }> {
		return this.http.requestJson<{ id: string }>('/auth/tokens', {
			method: 'POST',
			body: JSON.stringify({
				token_hash: tokenHash,
				device_id: device?.deviceId,
				device_name: device?.deviceName,
				platform: device?.platform,
			}),
		});
	}

	async revokeToken(id: string): Promise<{ success: boolean }> {
		return this.http.requestJson<{ success: boolean }>('/auth/tokens', {
			method: 'DELETE',
			body: JSON.stringify({ id }),
		});
	}

	async listTokens(): Promise<{ tokens: RegisteredDevice[] }> {
		return this.http.requestJson<{ tokens: RegisteredDevice[] }>('/auth/tokens');
	}
}

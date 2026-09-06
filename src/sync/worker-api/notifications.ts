import type { WorkerApiHttpClient } from './http';

export interface PushSubscriptionsResponse {
	subscriptions: Array<{
		id: string;
		device_name: string | null;
		created_at: string;
		disabled_at?: string | null;
		last_error?: string | null;
	}>;
}

export interface PushTestResponse {
	sent: number;
	failed: number;
	pruned: number;
	quarantined: number;
	errors: string[];
}

export class NotificationsWorkerApi {
	constructor(private readonly http: WorkerApiHttpClient) {}




	async getPushSubscriptions(): Promise<PushSubscriptionsResponse> {
		return this.http.requestJson<PushSubscriptionsResponse>('/notifications/subscriptions');
	}


	async createRemindersEnrollmentToken(folderPath: string): Promise<{ token: string; browserToken: string; expiresAt: string }> {
		return this.http.requestJson('/notifications/reminders-enrollment-token', {
			method: 'POST',
			body: JSON.stringify({ folderPath }),
		});
	}

	async deletePushSubscription(id: string): Promise<{ success: boolean }> {
		return this.http.requestJson<{ success: boolean }>('/notifications/subscribe', {
			method: 'DELETE',
			body: JSON.stringify({ id }),
		});
	}

	async testPush(): Promise<PushTestResponse> {
		return this.http.requestJson<PushTestResponse>('/notifications/test', { method: 'POST' });
	}
}

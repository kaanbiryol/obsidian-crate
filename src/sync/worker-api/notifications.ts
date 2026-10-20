import type { WorkerApiHttpClient } from './http';
import type { NotificationPolicy } from '../../protocol/notification-policy';

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

	retryPausedNotifications(): Promise<{ retried: number; more: boolean }> {
		return this.http.requestJson('/notifications/retry', { method: 'POST' });
	}

	ensureNotificationPolicy(policy: Omit<NotificationPolicy, 'revision'>): Promise<{ policy: NotificationPolicy }> {
		return this.http.requestJson('/reminders/notification-policy', { method: 'POST', body: JSON.stringify(policy) });
	}

	getNotificationPolicy(): Promise<{ policy: NotificationPolicy | null }> {
		return this.http.requestJson('/reminders/notification-policy');
	}

	updateNotificationPolicy(policy: NotificationPolicy): Promise<{ policy: NotificationPolicy }> {
		return this.http.requestJson('/reminders/notification-policy', { method: 'PUT', body: JSON.stringify({ ...policy, expectedRevision: policy.revision }) });
	}

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

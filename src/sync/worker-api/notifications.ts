import type { WorkerApiHttpClient } from './http';

export interface ReminderScheduleRequest {
	reminderId: string;
	content: string;
	project?: string;
	dueDatetime: string;
	priority?: number;
}

export interface ScheduledReminderResponse {
	scheduled: Array<{
		reminder_id: string;
		content: string;
		project: string | null;
		due_datetime: string;
	}>;
}

export interface PushSubscriptionsResponse {
	subscriptions: Array<{
		id: string;
		device_name: string | null;
		created_at: string;
	}>;
}

export interface PushTestResponse {
	sent: number;
	failed: number;
	pruned: number;
	errors: string[];
}

export class NotificationsWorkerApi {
	constructor(private readonly http: WorkerApiHttpClient) {}

	async scheduleReminder(data: ReminderScheduleRequest): Promise<{ success: boolean }> {
		return this.http.requestJson<{ success: boolean }>('/reminders/schedule', {
			method: 'POST',
			body: JSON.stringify(data),
		});
	}

	async cancelReminder(reminderId: string): Promise<{ success: boolean }> {
		return this.http.requestJson<{ success: boolean }>('/reminders/cancel', {
			method: 'DELETE',
			body: JSON.stringify({ reminderId }),
		});
	}

	async getScheduledReminders(): Promise<ScheduledReminderResponse> {
		return this.http.requestJson<ScheduledReminderResponse>('/reminders/scheduled');
	}

	async getPushSubscriptions(): Promise<PushSubscriptionsResponse> {
		return this.http.requestJson<PushSubscriptionsResponse>('/notifications/subscriptions');
	}

	async createPushEnrollmentToken(): Promise<{ token: string; expiresAt: string }> {
		return this.http.requestJson('/notifications/enrollment-token', {
			method: 'POST',
		});
	}

	async createRemindersEnrollmentToken(): Promise<{ token: string; expiresAt: string }> {
		return this.http.requestJson('/notifications/reminders-enrollment-token', {
			method: 'POST',
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

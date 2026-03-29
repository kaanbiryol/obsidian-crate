import type { CrateSettings } from '../../plugin/types';
import type { SyncApiClient } from '../../sync/api';
import type { Reminder } from '../types/reminder';
import { createLogger } from '../utils/logger';

const log = createLogger('ReminderNotificationService');

interface NotificationMutationResult {
	success: boolean;
	error?: string;
}

export class ReminderNotificationService {
	constructor(
		private getSettings: () => CrateSettings,
		private getApiClient: () => SyncApiClient | null,
	) {}

	private isAvailable(): boolean {
		const settings = this.getSettings();
		const api = this.getApiClient();
		return !!(settings.pushEnabled && api);
	}

	private getSchedulableDueDate(dueDatetime: string | null | undefined): Date | null {
		if (!dueDatetime) {
			return null;
		}

		const dueDate = new Date(dueDatetime);
		if (Number.isNaN(dueDate.getTime()) || dueDate <= new Date()) {
			return null;
		}

		return dueDate;
	}

	private ensureOperationSucceeded(
		result: NotificationMutationResult,
		action: 'schedule' | 'cancel',
		reminderId: string,
	): void {
		if (result.success) {
			return;
		}

		throw new Error(result.error ?? `Failed to ${action} reminder ${reminderId}`);
	}

	async onReminderCreated(reminder: Reminder): Promise<void> {
		if (!this.isAvailable()) return;
		if (reminder.completed || !this.getSchedulableDueDate(reminder.dueDatetime)) return;

		await this.schedule(reminder);
	}

	async onReminderUpdated(reminder: Reminder): Promise<void> {
		if (!this.isAvailable()) return;

		if (reminder.completed || !this.getSchedulableDueDate(reminder.dueDatetime)) {
			await this.cancel(reminder.id);
			return;
		}

		await this.schedule(reminder);
	}

	async onReminderDeleted(reminderId: string): Promise<void> {
		if (!this.isAvailable()) return;
		await this.cancel(reminderId);
	}

	async onReminderChange(
		reminder: Reminder,
		operation: 'create' | 'update' | 'delete',
	): Promise<{ success: boolean; error?: string }> {
		try {
			switch (operation) {
				case 'create':
					await this.onReminderCreated(reminder);
					break;
				case 'update':
					await this.onReminderUpdated(reminder);
					break;
				case 'delete':
					await this.onReminderDeleted(reminder.id);
					break;
			}
			return { success: true };
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			log.error(`Notification sync failed (${operation}):`, error);
			return { success: false, error: msg };
		}
	}

	async reconcile(reminders: Reminder[]): Promise<void> {
		if (!this.isAvailable()) return;

		const api = this.getApiClient()!;
		try {
			const { scheduled } = await api.getScheduledReminders();
			const scheduledIds = new Set(scheduled.map(s => s.reminder_id));

			const shouldBeScheduled = reminders.filter(
				r => !r.completed && this.getSchedulableDueDate(r.dueDatetime) !== null,
			);
			const shouldBeScheduledIds = new Set(shouldBeScheduled.map(r => r.id));
			const operations: Array<Promise<NotificationMutationResult>> = [];

			for (const s of scheduled) {
				if (!shouldBeScheduledIds.has(s.reminder_id)) {
					operations.push(this.cancel(s.reminder_id));
				}
			}

			for (const r of shouldBeScheduled) {
				if (!scheduledIds.has(r.id)) {
					operations.push(this.schedule(r));
				}
			}

			const results = await Promise.allSettled(operations);
			const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
			if (failures.length > 0) {
				throw failures[0].reason;
			}
		} catch (err) {
			log.error('Failed to reconcile reminders:', err);
		}
	}

	private async schedule(reminder: Reminder): Promise<NotificationMutationResult> {
		const api = this.getApiClient();
		if (!api) {
			throw new Error('Reminder notifications are unavailable');
		}

		const result = await api.scheduleReminder({
			reminderId: reminder.id,
			content: reminder.content,
			project: reminder.project,
			dueDatetime: reminder.dueDatetime!,
			priority: reminder.priority,
		});

		this.ensureOperationSucceeded(result, 'schedule', reminder.id);
		return result;
	}

	private async cancel(reminderId: string): Promise<NotificationMutationResult> {
		const api = this.getApiClient();
		if (!api) {
			throw new Error('Reminder notifications are unavailable');
		}

		const result = await api.cancelReminder(reminderId);
		this.ensureOperationSucceeded(result, 'cancel', reminderId);
		return result;
	}
}

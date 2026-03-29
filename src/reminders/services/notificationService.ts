import type { CrateSettings } from '../../types';
import type { SyncApiClient } from '../../sync/api';
import type { Reminder } from '../types/reminder';
import { createLogger } from '../utils/logger';

const log = createLogger('ReminderNotificationService');

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

	async onReminderCreated(reminder: Reminder): Promise<void> {
		if (!this.isAvailable()) return;
		if (!reminder.dueDatetime || reminder.completed) return;

		const dueDate = new Date(reminder.dueDatetime);
		if (dueDate <= new Date()) return;

		await this.schedule(reminder);
	}

	async onReminderUpdated(reminder: Reminder): Promise<void> {
		if (!this.isAvailable()) return;

		if (reminder.completed || !reminder.dueDatetime) {
			await this.cancel(reminder.id);
			return;
		}

		const dueDate = new Date(reminder.dueDatetime);
		if (dueDate <= new Date()) {
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

			const now = new Date();
			const shouldBeScheduled = reminders.filter(
				r => !r.completed && r.dueDatetime && new Date(r.dueDatetime) > now,
			);
			const shouldBeScheduledIds = new Set(shouldBeScheduled.map(r => r.id));
			const operations: Promise<{ success: boolean }>[] = [];

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

	private async schedule(reminder: Reminder): Promise<{ success: boolean }> {
		const api = this.getApiClient();
		if (!api) {
			throw new Error('Reminder notifications are unavailable');
		}

		return api.scheduleReminder({
			reminderId: reminder.id,
			content: reminder.content,
			project: reminder.project,
			dueDatetime: reminder.dueDatetime!,
			priority: reminder.priority,
		});
	}

	private async cancel(reminderId: string): Promise<{ success: boolean }> {
		const api = this.getApiClient();
		if (!api) {
			throw new Error('Reminder notifications are unavailable');
		}

		return api.cancelReminder(reminderId);
	}
}

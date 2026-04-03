import type { CrateSettings } from '../../plugin/types';
import type { SyncApiClient } from '../../sync/api';
import type { Reminder } from '../types/reminder';
import { createLogger } from '../utils/logger';

const log = createLogger('ReminderNotificationService');

interface NotificationMutationResult {
	success: boolean;
	error?: string;
}

interface ScheduledReminderRecord {
	reminder_id: string;
	content: string;
	project: string | null;
	due_datetime: string;
}

type SchedulableReminder = Pick<
	Reminder,
	'id' | 'content' | 'dueDatetime' | 'priority' | 'completed' | 'project'
>;

function normalizeProject(project: string | null | undefined): string | null {
	const trimmed = project?.trim() ?? '';
	return trimmed.length > 0 ? trimmed : null;
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

	async onReminderCreated(reminder: SchedulableReminder): Promise<void> {
		if (!this.isAvailable()) return;
		if (reminder.completed || !this.getSchedulableDueDate(reminder.dueDatetime)) return;

		await this.schedule(reminder);
	}

	async onReminderUpdated(reminder: SchedulableReminder): Promise<void> {
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
		reminder: SchedulableReminder,
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

	async reconcile(reminders: SchedulableReminder[]): Promise<void> {
		if (!this.isAvailable()) return;

		const api = this.getApiClient()!;
		try {
			const { scheduled } = await api.getScheduledReminders();
			const scheduledById = new Map(scheduled.map((entry) => [entry.reminder_id, entry] as const));

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
				const existing = scheduledById.get(r.id);
				if (!existing || this.shouldReschedule(existing, r)) {
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

	private shouldReschedule(scheduled: ScheduledReminderRecord, reminder: SchedulableReminder): boolean {
		return scheduled.content !== reminder.content
			|| normalizeProject(scheduled.project) !== normalizeProject(reminder.project)
			|| scheduled.due_datetime !== reminder.dueDatetime;
	}

	private async schedule(reminder: SchedulableReminder): Promise<NotificationMutationResult> {
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

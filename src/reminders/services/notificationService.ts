import { errorMessage } from '../../plugin/logger';
import type { CrateSettings } from '../../plugin/types';
import type { SyncApiClient } from '../../sync/api';
import type { RemindersSettings } from '../settings';
import type { Reminder } from '../types/reminder';
import { parseLocalDateKey } from '../utils/reminderDate';
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
	'id' | 'content' | 'dueDate' | 'dueDatetime' | 'priority' | 'completed' | 'project'
>;

function normalizeProject(project: string | null | undefined): string | null {
	const trimmed = project?.trim() ?? '';
	return trimmed.length > 0 ? trimmed : null;
}

export class ReminderNotificationService {
	constructor(
		private getSettings: () => CrateSettings,
		private getRemindersSettings: () => RemindersSettings,
		private getApiClient: () => SyncApiClient | null,
	) {}

	private isAvailable(): boolean {
		const settings = this.getSettings();
		const api = this.getApiClient();
		return !!(settings.pushEnabled && api);
	}

	private resolveNotificationDatetime(reminder: SchedulableReminder): string | undefined {
		if (reminder.dueDatetime) {
			return reminder.dueDatetime;
		}

		const allDayTime = this.getRemindersSettings().allDayNotificationTime;
		if (!allDayTime || !reminder.dueDate) {
			return undefined;
		}

		const [hours, minutes] = allDayTime.split(':').map(Number);
		const date = parseLocalDateKey(reminder.dueDate);
		date.setHours(hours, minutes, 0, 0);
		return date.toISOString();
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
		const effectiveDatetime = this.resolveNotificationDatetime(reminder);
		if (reminder.completed || !this.getSchedulableDueDate(effectiveDatetime)) return;

		await this.schedule(reminder, effectiveDatetime!);
	}

	async onReminderUpdated(reminder: SchedulableReminder): Promise<void> {
		if (!this.isAvailable()) return;
		const effectiveDatetime = this.resolveNotificationDatetime(reminder);

		if (reminder.completed || !this.getSchedulableDueDate(effectiveDatetime)) {
			await this.cancel(reminder.id);
			return;
		}

		await this.schedule(reminder, effectiveDatetime!);
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
			const msg = errorMessage(error);
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

			const resolvedDatetimes = new Map<string, string>();
			const shouldBeScheduled = reminders.filter(r => {
				if (r.completed) return false;
				const effectiveDatetime = this.resolveNotificationDatetime(r);
				if (!this.getSchedulableDueDate(effectiveDatetime)) return false;
				resolvedDatetimes.set(r.id, effectiveDatetime!);
				return true;
			});
			const shouldBeScheduledIds = new Set(shouldBeScheduled.map(r => r.id));
			const operations: Array<Promise<NotificationMutationResult>> = [];

			for (const s of scheduled) {
				if (!shouldBeScheduledIds.has(s.reminder_id)) {
					operations.push(this.cancel(s.reminder_id));
				}
			}

			for (const r of shouldBeScheduled) {
				const existing = scheduledById.get(r.id);
				const effectiveDatetime = resolvedDatetimes.get(r.id)!;
				if (!existing || this.shouldReschedule(existing, r, effectiveDatetime)) {
					operations.push(this.schedule(r, effectiveDatetime));
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

	private shouldReschedule(
		scheduled: ScheduledReminderRecord,
		reminder: SchedulableReminder,
		effectiveDatetime: string,
	): boolean {
		return scheduled.content !== reminder.content
			|| normalizeProject(scheduled.project) !== normalizeProject(reminder.project)
			|| scheduled.due_datetime !== effectiveDatetime;
	}

	private async schedule(
		reminder: SchedulableReminder,
		effectiveDatetime: string,
	): Promise<NotificationMutationResult> {
		const api = this.getApiClient();
		if (!api) {
			throw new Error('Reminder notifications are unavailable');
		}

		const result = await api.scheduleReminder({
			reminderId: reminder.id,
			content: reminder.content,
			project: reminder.project,
			dueDatetime: effectiveDatetime,
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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReminderNotificationService } from './notificationService';
import type { CrateSettings } from '../../plugin/types';
import type { SyncApiClient } from '../../sync/api';
import { DEFAULT_REMINDERS_SETTINGS, type RemindersSettings } from '../settings';
import type { Reminder } from '../types/reminder';

type ScheduleReminderPayload = Parameters<SyncApiClient['scheduleReminder']>[0];

function createSettings(overrides: Partial<CrateSettings> = {}): CrateSettings {
	return {
		workerUrl: 'https://crate.example.workers.dev',
		cloudflareAccountId: '',
		workerName: '',
		bucketName: '',
		databaseId: '',
		lastSync: null,
		lastSeq: 0,
		deviceId: 'device-test',
		ignorePatterns: [],
		syncOnStartup: true,
		syncOnResume: true,
		syncInterval: 300,
		showStatusBar: true,
		syncHistory: [],
		pushEnabled: true,
		syncDebugLogging: false,
		debounceDelay: 5,
		...overrides,
	};
}

function createRemindersSettings(overrides: Partial<RemindersSettings> = {}): RemindersSettings {
	return { ...DEFAULT_REMINDERS_SETTINGS, ...overrides };
}

function createReminder(overrides: Partial<Reminder> = {}): Reminder {
	return {
		id: 'rem-1',
		content: 'Test reminder',
		dueDatetime: '2027-01-10T10:00:00.000Z',
		dueDate: '2027-01-10',
		priority: 4,
		completed: false,
		project: 'Inbox',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

describe('ReminderNotificationService', () => {
	const scheduleReminder = vi.fn();
	const cancelReminder = vi.fn();
	const getScheduledReminders = vi.fn();

	const apiClient = {
		scheduleReminder,
		cancelReminder,
		getScheduledReminders,
	};

	beforeEach(() => {
		scheduleReminder.mockReset();
		cancelReminder.mockReset();
		getScheduledReminders.mockReset();
	});

	it('returns a failure result when scheduling throws', async () => {
		scheduleReminder.mockRejectedValueOnce(new Error('network down'));

		const service = new ReminderNotificationService(
			() => createSettings(),
			() => createRemindersSettings(),
			() => apiClient as never,
		);

		const result = await service.onReminderChange(createReminder(), 'create');

		expect(result).toEqual({ success: false, error: 'network down' });
		expect(scheduleReminder).toHaveBeenCalledTimes(1);
	});

	it('treats unsuccessful schedule responses as failures', async () => {
		scheduleReminder.mockResolvedValueOnce({ success: false, error: 'worker rejected schedule' });

		const service = new ReminderNotificationService(
			() => createSettings(),
			() => createRemindersSettings(),
			() => apiClient as never,
		);

		const result = await service.onReminderChange(createReminder(), 'create');

		expect(result).toEqual({ success: false, error: 'worker rejected schedule' });
	});

	it('skips invalid due dates instead of scheduling them', async () => {
		const service = new ReminderNotificationService(
			() => createSettings(),
			() => createRemindersSettings(),
			() => apiClient as never,
		);

		await service.onReminderCreated(createReminder({ dueDatetime: 'not-a-date' }));

		expect(scheduleReminder).not.toHaveBeenCalled();
	});

	it('cancels and schedules reminders during reconciliation before resolving', async () => {
		getScheduledReminders.mockResolvedValueOnce({
			scheduled: [
				{
					reminder_id: 'stale-reminder',
					content: 'Old reminder',
					project: 'Inbox',
					due_datetime: '2026-01-01T10:00:00.000Z',
				},
			],
		});
		cancelReminder.mockResolvedValue({ success: true });
		scheduleReminder.mockResolvedValue({ success: true });

		const service = new ReminderNotificationService(
			() => createSettings(),
			() => createRemindersSettings(),
			() => apiClient as never,
		);

		await service.reconcile([
			createReminder({ id: 'fresh-reminder' }),
			createReminder({ id: 'completed-reminder', completed: true }),
		]);

		expect(cancelReminder).toHaveBeenCalledWith('stale-reminder');
		expect(scheduleReminder).toHaveBeenCalledWith({
			reminderId: 'fresh-reminder',
			content: 'Test reminder',
			project: 'Inbox',
			dueDatetime: '2027-01-10T10:00:00.000Z',
			priority: 4,
		});
	});

	it('schedules date-only reminders at the configured all-day notification time', async () => {
		scheduleReminder.mockResolvedValueOnce({ success: true });

		const service = new ReminderNotificationService(
			() => createSettings(),
			() => createRemindersSettings({ allDayNotificationTime: '09:00' }),
			() => apiClient as never,
		);

		await service.onReminderCreated(createReminder({ dueDatetime: undefined, dueDate: '2027-06-15' }));

		expect(scheduleReminder).toHaveBeenCalledTimes(1);
		const call = scheduleReminder.mock.calls[0]?.[0] as ScheduleReminderPayload | undefined;
		expect(call?.dueDatetime).toContain('2027-06-15');
	});

	it('skips date-only reminders when allDayNotificationTime is null', async () => {
		const service = new ReminderNotificationService(
			() => createSettings(),
			() => createRemindersSettings({ allDayNotificationTime: null }),
			() => apiClient as never,
		);

		await service.onReminderCreated(createReminder({ dueDatetime: undefined, dueDate: '2027-06-15' }));

		expect(scheduleReminder).not.toHaveBeenCalled();
	});

	it('uses explicit dueDatetime over allDayNotificationTime', async () => {
		scheduleReminder.mockResolvedValueOnce({ success: true });

		const service = new ReminderNotificationService(
			() => createSettings(),
			() => createRemindersSettings({ allDayNotificationTime: '09:00' }),
			() => apiClient as never,
		);

		await service.onReminderCreated(createReminder());

		expect(scheduleReminder).toHaveBeenCalledWith(
			expect.objectContaining({ dueDatetime: '2027-01-10T10:00:00.000Z' }),
		);
	});

	it('reschedules reminders when the remote schedule drifted from the current reminder state', async () => {
		getScheduledReminders.mockResolvedValueOnce({
			scheduled: [
				{
					reminder_id: 'rem-1',
					content: 'Old reminder',
					project: 'Old project',
					due_datetime: '2027-01-09T10:00:00.000Z',
				},
			],
		});
		scheduleReminder.mockResolvedValue({ success: true });

		const service = new ReminderNotificationService(
			() => createSettings(),
			() => createRemindersSettings(),
			() => apiClient as never,
		);

		await service.reconcile([createReminder()]);

		expect(cancelReminder).not.toHaveBeenCalled();
		expect(scheduleReminder).toHaveBeenCalledTimes(1);
		expect(scheduleReminder).toHaveBeenCalledWith({
			reminderId: 'rem-1',
			content: 'Test reminder',
			project: 'Inbox',
			dueDatetime: '2027-01-10T10:00:00.000Z',
			priority: 4,
		});
	});
});

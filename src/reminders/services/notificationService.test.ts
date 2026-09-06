import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReminderNotificationService } from './notificationService';
import type { CrateSettings } from '../../plugin/settings-types';
import { DEFAULT_REMINDERS_SETTINGS, type RemindersSettings } from '../settings';
import type { Reminder } from '../types/reminder';


function createSettings(overrides: Partial<CrateSettings> = {}): CrateSettings {
	return {
		workerUrl: 'https://crate.example.workers.dev',
		cloudflareDeployment: null,
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
		...overrides,
	};
}

describe('ReminderNotificationService', () => {
  const ensureNotificationPolicy = vi.fn();
  const scheduleReminder = vi.fn();
  const cancelReminder = vi.fn();
  const getScheduledReminders = vi.fn();
  const apiClient = { ensureNotificationPolicy, scheduleReminder, cancelReminder, getScheduledReminders };
  const service = (enabled = true) => new ReminderNotificationService(() => createSettings({ pushEnabled: enabled }), () => createRemindersSettings(), () => apiClient as never);
  beforeEach(() => { vi.resetAllMocks(); ensureNotificationPolicy.mockResolvedValue({ policy: {} }); });
  it('reports failures to reach the policy server', async () => {
    ensureNotificationPolicy.mockRejectedValueOnce(new Error('network down'));
    expect(await service().onReminderChange(createReminder(), 'create')).toEqual({ success: false, error: 'network down' });
  });
  it('coalesces overlapping refreshes without transmitting local reminder snapshots', async () => {
    let resolve!: (value: unknown) => void;
    ensureNotificationPolicy.mockImplementationOnce(() => new Promise<unknown>(r => { resolve = r; }));
    const client = service();
    const first = client.reconcile(Array.from({ length: 1000 }, (_, i) => createReminder({ id: String(i) })));
    const second = client.onReminderDeleted('deleted-locally');
    expect(ensureNotificationPolicy).toHaveBeenCalledTimes(1);
    const payload = ensureNotificationPolicy.mock.calls[0]?.[0] as { folderPath: string; timezone: string };
    expect(payload.folderPath).toBe('Reminders');
    expect(typeof payload.timezone).toBe('string');
    resolve({ policy: {} });
    await Promise.all([first, second]);
    expect(scheduleReminder).not.toHaveBeenCalled();
    expect(cancelReminder).not.toHaveBeenCalled();
    expect(getScheduledReminders).not.toHaveBeenCalled();
  });
  it.each(['create', 'update', 'delete'] as const)('only hints at server projection for a local %s', async operation => {
    await service().onReminderChange(createReminder({ dueDatetime: 'not-a-date' }), operation);
    expect(ensureNotificationPolicy).toHaveBeenCalledTimes(1);
    expect(scheduleReminder).not.toHaveBeenCalled();
    expect(cancelReminder).not.toHaveBeenCalled();
  });
  it('does not change shared schedules when a device disables local integration', async () => {
    const client = service(false);
    await client.reconcile([createReminder()]);
    await client.cancelAll();
    expect(ensureNotificationPolicy).not.toHaveBeenCalled();
    expect(cancelReminder).not.toHaveBeenCalled();
  });
  it('allows a later refresh after an earlier failure', async () => {
    ensureNotificationPolicy.mockRejectedValueOnce(new Error('offline'));
    const client = service();
    await expect(client.onReminderCreated(createReminder())).rejects.toThrow('offline');
    await client.onReminderUpdated(createReminder());
    expect(ensureNotificationPolicy).toHaveBeenCalledTimes(2);
  });
});

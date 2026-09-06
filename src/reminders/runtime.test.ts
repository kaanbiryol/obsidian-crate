import { describe, expect, it, vi } from 'vitest';
import { ensureReminderNotificationPolicy } from './runtime';
import type CratePlugin from '../main';

function harness(pushEnabled = true) {
	const ensureNotificationPolicy = vi.fn().mockResolvedValue({ policy: {} });
	const plugin = {
		settings: { pushEnabled },
		remindersSettings: { remindersFolderPath: 'Tasks', allDayNotificationTime: '09:00' },
		syncRuntime: { getApiClient: () => ({ ensureNotificationPolicy }) },
	} as unknown as CratePlugin;
	return { plugin, ensureNotificationPolicy };
}

describe('reminder notification policy initialization', () => {
	it('coalesces overlapping requests and sends only policy settings', async () => {
		const { plugin, ensureNotificationPolicy } = harness();
		await Promise.all([ensureReminderNotificationPolicy(plugin), ensureReminderNotificationPolicy(plugin)]);
		expect(ensureNotificationPolicy).toHaveBeenCalledExactlyOnceWith({
			folderPath: 'Tasks', allDayTime: '09:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		});
	});

	it('does not contact the server when notifications are disabled', async () => {
		const { plugin, ensureNotificationPolicy } = harness(false);
		await ensureReminderNotificationPolicy(plugin);
		expect(ensureNotificationPolicy).not.toHaveBeenCalled();
	});

	it('allows a later attempt after a network failure', async () => {
		const { plugin, ensureNotificationPolicy } = harness();
		ensureNotificationPolicy.mockRejectedValueOnce(new Error('offline'));
		await ensureReminderNotificationPolicy(plugin);
		await ensureReminderNotificationPolicy(plugin);
		expect(ensureNotificationPolicy).toHaveBeenCalledTimes(2);
	});
});

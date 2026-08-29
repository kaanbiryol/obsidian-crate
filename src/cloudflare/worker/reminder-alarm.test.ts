import { describe, expect, it, vi } from 'vitest';
import { ReminderAlarm } from './reminder-alarm';
import { sendToAllSubscriptions } from './push';

vi.mock('./push', () => ({
	sendToAllSubscriptions: vi.fn(),
}));

function createHarness() {
	const reminder = {
		reminderId: 'reminder-1',
		content: 'Ship it',
		project: 'Work',
		dueDatetime: '2099-01-01T00:00:00.000Z',
	};
	const deleteAll = vi.fn(async () => {});
	const run = vi.fn(async () => ({}));
	const state = {
		storage: {
			get: vi.fn(async () => reminder),
			deleteAll,
		},
	} as unknown as DurableObjectState;
	const db = {
		prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run })) })),
	} as unknown as D1Database;
	return { alarm: new ReminderAlarm(state, { DB: db }), deleteAll, run };
}

describe('reminder alarm delivery', () => {
	it('keeps alarm state when push delivery fails so Cloudflare can retry', async () => {
		vi.mocked(sendToAllSubscriptions).mockResolvedValue({
			sent: 0,
			failed: 1,
			pruned: 0,
			errors: ['temporary failure'],
		});
		const harness = createHarness();

		await expect(harness.alarm.alarm()).rejects.toThrow('Push delivery failed');
		expect(harness.run).not.toHaveBeenCalled();
		expect(harness.deleteAll).not.toHaveBeenCalled();
	});

	it('cleans up only after delivery finishes without retryable failures', async () => {
		vi.mocked(sendToAllSubscriptions).mockResolvedValue({
			sent: 1,
			failed: 0,
			pruned: 0,
			errors: [],
		});
		const harness = createHarness();

		await harness.alarm.alarm();
		expect(harness.run).toHaveBeenCalledTimes(1);
		expect(harness.deleteAll).toHaveBeenCalledTimes(1);
	});
});

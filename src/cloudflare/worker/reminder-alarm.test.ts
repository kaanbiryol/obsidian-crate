import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReminderAlarm } from './reminder-alarm';
import { listPushSubscriptionIds, sendToAllSubscriptions } from './push';

vi.mock('./push', () => ({
	listPushSubscriptionIds: vi.fn(),
	sendToAllSubscriptions: vi.fn(),
}));

beforeEach(() => {
	vi.clearAllMocks();
});

function createHarness() {
	const reminder = {
		reminderId: 'reminder-1',
		content: 'Ship it',
		project: 'Work',
		dueDatetime: '2099-01-01T00:00:00.000Z',
	};
	const storedValues = new Map<string, unknown>([['reminder', reminder]]);
	const deleteAll = vi.fn(async () => {});
	const put = vi.fn(async (key: string, value: unknown) => {
		storedValues.set(key, value);
	});
	const run = vi.fn(async () => ({}));
	const state = {
		storage: {
			get: vi.fn(async (key: string) => storedValues.get(key)),
			put,
			deleteAll,
		},
	} as unknown as DurableObjectState;
	const db = {
		prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run })) })),
	} as unknown as D1Database;
	return { alarm: new ReminderAlarm(state, { DB: db }), deleteAll, put, run, storedValues };
}

describe('reminder alarm delivery', () => {
	it('retries only subscriptions whose push delivery failed', async () => {
		vi.mocked(listPushSubscriptionIds).mockResolvedValue(['subscription-1', 'subscription-2']);
		vi.mocked(sendToAllSubscriptions)
			.mockResolvedValueOnce({
				sent: 1,
				failed: 1,
				pruned: 0,
				errors: ['temporary failure'],
				failedSubscriptionIds: ['subscription-2'],
			})
			.mockResolvedValueOnce({
				sent: 1,
				failed: 0,
				pruned: 0,
				errors: [],
				failedSubscriptionIds: [],
			});
		const harness = createHarness();

		await expect(harness.alarm.alarm()).rejects.toThrow('Push delivery failed');
		expect(harness.storedValues.get('pendingSubscriptionIds')).toEqual(['subscription-2']);
		expect(harness.run).not.toHaveBeenCalled();
		expect(harness.deleteAll).not.toHaveBeenCalled();

		await harness.alarm.alarm();

		expect(listPushSubscriptionIds).toHaveBeenCalledOnce();
		expect(sendToAllSubscriptions).toHaveBeenNthCalledWith(1, expect.anything(), expect.anything(), {
			subscriptionIds: ['subscription-1', 'subscription-2'],
		});
		expect(sendToAllSubscriptions).toHaveBeenNthCalledWith(2, expect.anything(), expect.anything(), {
			subscriptionIds: ['subscription-2'],
		});
		expect(harness.run).toHaveBeenCalledOnce();
		expect(harness.deleteAll).toHaveBeenCalledOnce();
	});

	it('keeps alarm state when every push delivery fails', async () => {
		vi.mocked(listPushSubscriptionIds).mockResolvedValue(['subscription-1']);
		vi.mocked(sendToAllSubscriptions).mockResolvedValue({
			sent: 0,
			failed: 1,
			pruned: 0,
			errors: ['temporary failure'],
			failedSubscriptionIds: ['subscription-1'],
		});
		const harness = createHarness();

		await expect(harness.alarm.alarm()).rejects.toThrow('Push delivery failed');
		expect(harness.run).not.toHaveBeenCalled();
		expect(harness.deleteAll).not.toHaveBeenCalled();
	});

	it('cleans up only after delivery finishes without retryable failures', async () => {
		vi.mocked(listPushSubscriptionIds).mockResolvedValue(['subscription-1']);
		vi.mocked(sendToAllSubscriptions).mockResolvedValue({
			sent: 1,
			failed: 0,
			pruned: 0,
			errors: [],
			failedSubscriptionIds: [],
		});
		const harness = createHarness();

		await harness.alarm.alarm();
		expect(harness.run).toHaveBeenCalledTimes(1);
		expect(harness.deleteAll).toHaveBeenCalledTimes(1);
	});
});

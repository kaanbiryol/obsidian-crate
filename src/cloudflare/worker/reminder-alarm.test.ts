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
		scheduleToken: 'schedule-token-1',
		content: 'Ship it',
		project: 'Work',
		dueDatetime: '2099-01-01T00:00:00.000Z',
	};
	const storedValues = new Map<string, unknown>([['reminder', reminder]]);
	const deleteAll = vi.fn(async () => {
		storedValues.clear();
	});
	const deleteValue = vi.fn(async (key: string) => storedValues.delete(key));
	const setAlarm = vi.fn(async () => {});
	const deleteAlarm = vi.fn(async () => {});
	const getAlarm = vi.fn(async () => Date.parse(reminder.dueDatetime));
	const put = vi.fn(async (key: string, value: unknown) => {
		storedValues.set(key, value);
	});
	const run = vi.fn(async () => ({}));
	const state = {
		storage: {
			get: vi.fn(async (key: string) => storedValues.get(key)),
			getAlarm,
			put,
			delete: deleteValue,
			deleteAll,
			setAlarm,
			deleteAlarm,
		},
	} as unknown as DurableObjectState;
	const scheduledReminder = {
		schedule_token: reminder.scheduleToken,
		content: reminder.content,
		project: reminder.project,
		due_datetime: reminder.dueDatetime,
	};
	const first = vi.fn(async (): Promise<typeof scheduledReminder | null> => scheduledReminder);
	const db = {
		prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run, first })) })),
	} as unknown as D1Database;
	return {
		alarm: new ReminderAlarm(state, { DB: db }),
		deleteAll,
		deleteAlarm,
		first,
		put,
		run,
		setAlarm,
		storedValues,
	};
}

describe('reminder alarm delivery', () => {
	it('deletes authoritative schedule metadata before clearing an alarm', async () => {
		const harness = createHarness();

		const response = await harness.alarm.fetch(new Request(
			'https://do/cancel?reminderId=reminder-1',
			{ method: 'DELETE' },
		));

		expect(response.status).toBe(200);
		expect(harness.run).toHaveBeenCalledOnce();
		expect(harness.deleteAlarm).toHaveBeenCalledOnce();
		expect(harness.deleteAll).toHaveBeenCalledOnce();
	});

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

	it('retries D1 cleanup without sending a duplicate push', async () => {
		vi.mocked(listPushSubscriptionIds).mockResolvedValue(['subscription-1']);
		vi.mocked(sendToAllSubscriptions).mockResolvedValue({
			sent: 1,
			failed: 0,
			pruned: 0,
			errors: [],
			failedSubscriptionIds: [],
		});
		const harness = createHarness();
		harness.run.mockRejectedValueOnce(new Error('D1 unavailable'));

		await harness.alarm.alarm();

		expect(sendToAllSubscriptions).toHaveBeenCalledOnce();
		expect(harness.storedValues.get('deliveryComplete')).toBe(true);
		expect(harness.setAlarm).toHaveBeenCalledOnce();
		expect(harness.deleteAll).not.toHaveBeenCalled();

		await harness.alarm.alarm();

		expect(sendToAllSubscriptions).toHaveBeenCalledOnce();
		expect(harness.run).toHaveBeenCalledTimes(2);
		expect(harness.deleteAll).toHaveBeenCalledOnce();
	});

	it('does not clear a newer schedule after an older alarm finishes', async () => {
		vi.mocked(listPushSubscriptionIds).mockResolvedValue([]);
		vi.mocked(sendToAllSubscriptions).mockResolvedValue({
			sent: 0,
			failed: 0,
			pruned: 0,
			errors: [],
			failedSubscriptionIds: [],
		});
		const harness = createHarness();
		const newerReminder = {
			reminderId: 'reminder-1',
			scheduleToken: 'newer-schedule-token',
			content: 'Rescheduled',
			dueDatetime: '2099-02-01T00:00:00.000Z',
		};
		harness.run.mockImplementationOnce(async () => {
			harness.storedValues.set('reminder', newerReminder);
			return {};
		});

		await harness.alarm.alarm();

		expect(harness.deleteAll).not.toHaveBeenCalled();
		expect(harness.storedValues.get('reminder')).toEqual(newerReminder);
	});

	it('discards an orphan alarm without sending when its D1 schedule is missing', async () => {
		const harness = createHarness();
		harness.first.mockResolvedValueOnce(null);

		await harness.alarm.alarm();

		expect(sendToAllSubscriptions).not.toHaveBeenCalled();
		expect(harness.deleteAll).toHaveBeenCalledOnce();
	});

	it('discards stale alarm state when its schedule token no longer matches D1', async () => {
		const harness = createHarness();
		harness.first.mockResolvedValueOnce({
			schedule_token: 'newer-schedule-token',
			content: 'Updated',
			project: 'Work',
			due_datetime: '2099-02-01T00:00:00.000Z',
		});

		await harness.alarm.alarm();

		expect(sendToAllSubscriptions).not.toHaveBeenCalled();
		expect(harness.deleteAll).toHaveBeenCalledOnce();
	});

	it('rolls back alarm state when D1 cannot persist a schedule', async () => {
		const harness = createHarness();
		harness.run.mockRejectedValueOnce(new Error('D1 unavailable'));

		const response = await harness.alarm.fetch(new Request('https://do/schedule', {
			method: 'PUT',
			body: JSON.stringify({
				reminderId: 'reminder-1',
				content: 'Updated reminder',
				dueDatetime: '2099-02-01T00:00:00.000Z',
			}),
		}));

		expect(response.status).toBe(500);
		expect(harness.storedValues.get('reminder')).toMatchObject({
			scheduleToken: 'schedule-token-1',
			content: 'Ship it',
		});
		expect(harness.deleteAlarm).toHaveBeenCalledOnce();
	});
});

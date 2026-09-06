import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReminderAlarm } from './notifications/reminder-alarm';
import { listPushSubscriptionIds, sendToAllSubscriptions } from './notifications/push';

vi.mock('./notifications/push', () => ({
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
	const setAlarm = vi.fn(async (_scheduledTime: number | Date) => {});
	const deleteAlarm = vi.fn(async () => {});
	const getAlarm = vi.fn(async () => Date.parse(reminder.dueDatetime));
	const put = vi.fn(async (key: string, value: unknown) => {
		storedValues.set(key, value);
	});
	const run = vi.fn(async () => ({ meta: { changes: 1 } }));
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
		prepare: vi.fn((sql: string) => ({ bind: vi.fn(() => ({ run, first: sql.includes('SELECT job_token') ? async () => ({ job_token: 'current-job' }) : sql.includes('LEFT JOIN reminder_projections')
            ? async () => ({ file_revision: 'source', storage_key: 'source', pending_path: null, enabled: 1,
                notification_token: scheduledReminder.schedule_token, policy_revision: 'policy', current_policy_revision: 'policy' })
            : first })) })),
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
			'https://do/cancel?reminderId=reminder-1&jobToken=current-job',
			{ method: 'DELETE' },
		));

		expect(response.status).toBe(200);
		expect(harness.run).toHaveBeenCalledOnce();
		expect(harness.deleteAlarm).toHaveBeenCalledOnce();
		expect(harness.storedValues.has('reminder')).toBe(false);
	});

	it('retries only subscriptions whose push delivery failed', async () => {
		vi.mocked(listPushSubscriptionIds).mockResolvedValue(['subscription-1', 'subscription-2']);
		vi.mocked(sendToAllSubscriptions)
			.mockResolvedValueOnce({
				sent: 1,
				failed: 1,
				pruned: 0,
				quarantined: 0,
				errors: ['temporary failure'],
				failedSubscriptionIds: ['subscription-2'],
			})
			.mockResolvedValueOnce({
				sent: 1,
				failed: 0,
				pruned: 0,
				quarantined: 0,
				errors: [],
				failedSubscriptionIds: [],
			});
		const harness = createHarness();

		await harness.alarm.alarm();
		expect(harness.storedValues.get('pendingSubscriptionIds')).toEqual(['subscription-2']);
		expect(harness.storedValues.get('retryAttempt')).toBe(1);
		expect(harness.setAlarm).toHaveBeenCalledOnce();
		expect(harness.run).not.toHaveBeenCalled();
		expect(harness.storedValues.has('reminder')).toBe(true);

		await harness.alarm.alarm();

		expect(listPushSubscriptionIds).toHaveBeenCalledOnce();
		expect(sendToAllSubscriptions).toHaveBeenNthCalledWith(1, expect.anything(), expect.anything(), {
			subscriptionIds: ['subscription-1', 'subscription-2'],
		});
		expect(sendToAllSubscriptions).toHaveBeenNthCalledWith(2, expect.anything(), expect.anything(), {
			subscriptionIds: ['subscription-2'],
		});
		expect(harness.run).toHaveBeenCalledOnce();
		expect(harness.storedValues.has('reminder')).toBe(false);
	});

	it('keeps alarm state when every push delivery fails', async () => {
		vi.mocked(listPushSubscriptionIds).mockResolvedValue(['subscription-1']);
		vi.mocked(sendToAllSubscriptions).mockResolvedValue({
			sent: 0,
			failed: 1,
			pruned: 0,
			quarantined: 0,
			errors: ['temporary failure'],
			failedSubscriptionIds: ['subscription-1'],
		});
		const harness = createHarness();

		await harness.alarm.alarm();
		expect(harness.storedValues.get('retryAttempt')).toBe(1);
		expect(harness.setAlarm).toHaveBeenCalledOnce();
		expect(harness.run).not.toHaveBeenCalled();
		expect(harness.storedValues.has('reminder')).toBe(true);
	});

	it('records a terminal delivery failure after the retry budget is exhausted', async () => {
		vi.mocked(listPushSubscriptionIds).mockResolvedValue(['subscription-1']);
		vi.mocked(sendToAllSubscriptions).mockResolvedValue({
			sent: 0,
			failed: 1,
			pruned: 0,
			quarantined: 0,
			errors: ['temporary failure'],
			failedSubscriptionIds: ['subscription-1'],
		});
		const harness = createHarness();
		harness.storedValues.set('retryAttempt', 10);
		vi.spyOn(console, 'error').mockImplementation(() => {});

		await harness.alarm.alarm();

		expect(harness.storedValues.get('deliveryFailure')).toEqual(expect.objectContaining({
			attempts: 10,
			error: 'Push delivery failed for 1 subscription(s)',
		}));
		expect(harness.deleteAlarm).toHaveBeenCalledOnce();
		expect(harness.setAlarm).not.toHaveBeenCalled();
	});

	it('cleans up only after delivery finishes without retryable failures', async () => {
		vi.mocked(listPushSubscriptionIds).mockResolvedValue(['subscription-1']);
		vi.mocked(sendToAllSubscriptions).mockResolvedValue({
			sent: 1,
			failed: 0,
			pruned: 0,
			quarantined: 0,
			errors: [],
			failedSubscriptionIds: [],
		});
		const harness = createHarness();

		await harness.alarm.alarm();
		expect(harness.run).toHaveBeenCalledTimes(1);
		expect(harness.storedValues.has('reminder')).toBe(false);
	});

	it('retries D1 cleanup without sending a duplicate push', async () => {
		vi.mocked(listPushSubscriptionIds).mockResolvedValue(['subscription-1']);
		vi.mocked(sendToAllSubscriptions).mockResolvedValue({
			sent: 1,
			failed: 0,
			pruned: 0,
			quarantined: 0,
			errors: [],
			failedSubscriptionIds: [],
		});
		const harness = createHarness();
		harness.run.mockRejectedValueOnce(new Error('D1 unavailable'));

		await harness.alarm.alarm();

		expect(sendToAllSubscriptions).toHaveBeenCalledOnce();
		expect(harness.storedValues.get('deliveryComplete')).toBe(true);
		expect(harness.setAlarm).toHaveBeenCalledOnce();
		expect(harness.storedValues.has('reminder')).toBe(true);

		await harness.alarm.alarm();

		expect(sendToAllSubscriptions).toHaveBeenCalledOnce();
		expect(harness.run).toHaveBeenCalledTimes(2);
		expect(harness.storedValues.has('reminder')).toBe(false);
	});

	it('keeps explicitly rescheduling transient D1 failures with bounded backoff', async () => {
		const harness = createHarness();
		harness.first.mockRejectedValueOnce(new Error('D1 unavailable'));

		await harness.alarm.alarm();

		expect(harness.storedValues.get('retryAttempt')).toBe(1);
		expect(harness.setAlarm).toHaveBeenCalledOnce();
		expect(harness.storedValues.has('reminder')).toBe(true);

		harness.first.mockRejectedValueOnce(new Error('D1 still unavailable'));
		await harness.alarm.alarm();

		expect(harness.storedValues.get('retryAttempt')).toBe(2);
		expect(harness.setAlarm).toHaveBeenCalledTimes(2);
		const firstRetry = Number(harness.setAlarm.mock.calls[0]?.[0]);
		const secondRetry = Number(harness.setAlarm.mock.calls[1]?.[0]);
		expect(secondRetry - Date.now()).toBeGreaterThan(firstRetry - Date.now());
	});

	it('does not clear a newer schedule after an older alarm finishes', async () => {
		vi.mocked(listPushSubscriptionIds).mockResolvedValue([]);
		vi.mocked(sendToAllSubscriptions).mockResolvedValue({
			sent: 0,
			failed: 0,
			pruned: 0,
			quarantined: 0,
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
			return { meta: { changes: 1 } };
		});

		await harness.alarm.alarm();

		expect(harness.storedValues.has('reminder')).toBe(true);
		expect(harness.storedValues.get('reminder')).toEqual(newerReminder);
	});

	it('discards an orphan alarm without sending when its D1 schedule is missing', async () => {
		const harness = createHarness();
		harness.first.mockResolvedValueOnce(null);

		await harness.alarm.alarm();

		expect(sendToAllSubscriptions).not.toHaveBeenCalled();
		expect(harness.storedValues.has('reminder')).toBe(false);
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
		expect(harness.storedValues.has('reminder')).toBe(false);
	});

	it('rolls back alarm state when D1 cannot persist a schedule', async () => {
		const harness = createHarness();
		harness.run.mockRejectedValueOnce(new Error('D1 unavailable'));

		const response = await harness.alarm.fetch(new Request('https://do/schedule', {
			method: 'PUT',
			body: JSON.stringify({
				reminderId: 'reminder-1',
				content: 'Updated reminder',
				jobToken: 'current-job',
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

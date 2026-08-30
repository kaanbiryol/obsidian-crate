import { describe, expect, it, vi } from 'vitest';
import { handleCancelReminder, handleScheduleReminder } from './reminder-handlers';

function createDb() {
	const statements: string[] = [];
	const db = {
		prepare: vi.fn((sql: string) => ({
			run: vi.fn(async () => {
				statements.push(sql);
				return {};
			}),
			bind: vi.fn(() => ({
				run: vi.fn(async () => {
					statements.push(sql);
					return {};
				}),
			})),
			all: vi.fn(async () => ({
				results: sql.includes('PRAGMA table_info(files)')
					? [{ name: 'path' }, { name: 'storage_key' }]
					: [],
			})),
		})),
	};

	return { db, statements };
}

describe('worker reminder handlers', () => {
	it('delegates scheduled reminder persistence to its Durable Object', async () => {
		const { db, statements } = createDb();
		const alarmFetch = vi.fn(async () => new Response(null, { status: 200 }));
		const env = {
			DB: db,
			REMINDER_ALARMS: {
				idFromName: vi.fn(() => 'alarm-id'),
				get: vi.fn(() => ({ fetch: alarmFetch })),
			},
		};

		const response = await handleScheduleReminder(
			new Request('https://worker.test/reminders/schedule', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					reminderId: 'rem-1',
					content: 'Pay rent',
					project: 'Home',
					dueDatetime: '2027-01-10T10:00:00.000Z',
				}),
			}),
			env as never,
		);

		expect(response.status).toBe(200);
		expect(statements).toEqual([]);
		expect(alarmFetch).toHaveBeenCalledTimes(1);
	});

	it('rejects reminder schedules in the past', async () => {
		const { db, statements } = createDb();
		const alarmFetch = vi.fn(async () => new Response(null, { status: 200 }));
		const env = {
			DB: db,
			REMINDER_ALARMS: {
				idFromName: vi.fn(() => 'alarm-id'),
				get: vi.fn(() => ({ fetch: alarmFetch })),
			},
		};

		const response = await handleScheduleReminder(
			new Request('https://worker.test/reminders/schedule', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					reminderId: 'rem-1',
					content: 'Pay rent',
					project: 'Home',
					dueDatetime: '2020-01-10T10:00:00.000Z',
				}),
			}),
			env as never,
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'dueDatetime must be in the future' });
		expect(alarmFetch).not.toHaveBeenCalled();
		expect(statements.some((sql) => sql.includes('INSERT OR REPLACE INTO scheduled_reminders'))).toBe(false);
	});

	it('reports a Durable Object cancellation failure', async () => {
		const { db, statements } = createDb();
		const alarmFetch = vi.fn(async () => new Response(null, { status: 500 }));
		const env = {
			DB: db,
			REMINDER_ALARMS: {
				idFromName: vi.fn(() => 'alarm-id'),
				get: vi.fn(() => ({ fetch: alarmFetch })),
			},
		};

		const response = await handleCancelReminder(
			new Request('https://worker.test/reminders/cancel', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reminderId: 'rem-1' }),
			}),
			env as never,
		);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: 'Failed to cancel alarm' });
		expect(statements).toEqual([]);
		expect(alarmFetch).toHaveBeenCalledWith(
			'https://do/cancel?reminderId=rem-1',
			{ method: 'DELETE' },
		);
	});

	it('reports a Durable Object scheduling failure', async () => {
		const { db } = createDb();
		const alarmFetch = vi.fn(async () => new Response(null, { status: 500 }));
		const env = {
			DB: db,
			REMINDER_ALARMS: {
				idFromName: vi.fn(() => 'alarm-id'),
				get: vi.fn(() => ({ fetch: alarmFetch })),
			},
		};

		const response = await handleScheduleReminder(
			new Request('https://worker.test/reminders/schedule', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					reminderId: 'rem-1',
					content: 'Pay rent',
					dueDatetime: '2027-01-10T10:00:00.000Z',
				}),
			}),
			env as never,
		);

		expect(response.status).toBe(500);
		expect(alarmFetch).toHaveBeenCalledTimes(1);
	});
});

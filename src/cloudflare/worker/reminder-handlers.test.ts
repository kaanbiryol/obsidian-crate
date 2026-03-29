import { describe, expect, it, vi } from 'vitest';
import { handleScheduleReminder } from './reminder-handlers';

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
		})),
	};

	return { db, statements };
}

describe('worker reminder handlers', () => {
	it('stores scheduled reminders without referencing legacy schema columns', async () => {
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
		const insertStatement = statements.find((sql) => sql.includes('INSERT OR REPLACE INTO scheduled_reminders'));
		expect(insertStatement).toContain('(reminder_id, content, project, due_datetime)');
		expect(insertStatement).not.toContain('ntfy_topic');
		expect(alarmFetch).toHaveBeenCalledTimes(1);
	});
});

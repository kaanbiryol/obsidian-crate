import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchReadyReminderList, readReminderListBody } from './reminder-api';

describe('fetchReadyReminderList', () => {
	afterEach(() => vi.useRealTimers());

	it('retries bounded cache-warming responses until the full list is ready', async () => {
		vi.useFakeTimers();
		const apiFetch = vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ warming: true }), { status: 202 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ warming: true }), { status: 202 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ reminders: [] }), { status: 200 }));

		const result = fetchReadyReminderList(apiFetch, '/reminders/list', new Headers());
		await vi.advanceTimersByTimeAsync(2_000);

		expect((await result).status).toBe(200);
		expect(apiFetch).toHaveBeenCalledTimes(3);
	});

	it('waits one second between requests when Retry-After is missing', async () => {
		vi.useFakeTimers();
		const apiFetch = vi.fn().mockImplementation(async () =>
			new Response(JSON.stringify({ warming: true }), { status: 202 }),
		);

		const result = fetchReadyReminderList(apiFetch, '/reminders/list', new Headers());
		const rejection = expect(result).rejects.toThrow('Reminder index is still preparing. Try again in a moment.');
		await vi.advanceTimersByTimeAsync(999);
		expect(apiFetch).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(600_000);
		await rejection;
		expect(apiFetch).toHaveBeenCalledTimes(601);
	});

	it('caps the total server-requested warm-up delay', async () => {
		vi.useFakeTimers();
		const apiFetch = vi.fn().mockImplementation(async () =>
			new Response(JSON.stringify({ warming: true }), {
				status: 202,
				headers: { 'Retry-After': '5' },
			}),
		);

		const result = fetchReadyReminderList(apiFetch, '/reminders/list', new Headers());
		const rejection = expect(result).rejects.toThrow('Try again in a moment');
		await vi.advanceTimersByTimeAsync(600_000);
		await rejection;
		expect(apiFetch).toHaveBeenCalledTimes(121);
	});

	it('honors bounded Retry-After delays between warm-up requests', async () => {
		vi.useFakeTimers();
		const apiFetch = vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ warming: true }), {
				status: 202,
				headers: { 'Retry-After': '1' },
			}))
			.mockResolvedValueOnce(new Response(JSON.stringify({ reminders: [] }), { status: 200 }));

		const result = fetchReadyReminderList(apiFetch, '/reminders/list', new Headers());
		await vi.advanceTimersByTimeAsync(999);
		expect(apiFetch).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		await expect(result).resolves.toMatchObject({ status: 200 });
	});
});

describe('readReminderListBody', () => {
	const record = (id: string, filePath: string) => ({ id, content: id, priority: 4 as const, completed: false, project: 'Inbox', filePath });
	const base = [record('a', 'Reminders/A.md'), record('b', 'Reminders/B.md')];

	it('reads a full list as-is', () => {
		const body = { reminders: [record('c', 'Reminders/C.md')], projects: ['Inbox'], issues: [] };
		expect(readReminderListBody(body, 'Reminders', base, undefined)).toEqual({ result: body, dropDeltaBase: false });
	});

	it('merges a requested delta into the confirmed base in note order', () => {
		const body = { delta: true, changedPaths: ['Reminders/B.md'], reminders: [record('b2', 'Reminders/B.md')], projects: ['Inbox'], issues: [] };
		const { result, dropDeltaBase } = readReminderListBody(body, 'Reminders', base, '7.base');
		expect(result?.reminders.map(item => item.id)).toEqual(['a', 'b2']);
		expect(dropDeltaBase).toBe(false);
	});

	it('drops the delta base for an unrequested or invalid delta', () => {
		const body = { delta: true, changedPaths: ['Reminders/B.md'], reminders: [], projects: ['Inbox'], issues: [] };
		expect(readReminderListBody(body, 'Reminders', base, undefined)).toEqual({ result: null, dropDeltaBase: true });
		expect(readReminderListBody({ ...body, changedPaths: ['Other/B.md'] }, 'Reminders', base, '7.base')).toEqual({ result: null, dropDeltaBase: true });
	});
});

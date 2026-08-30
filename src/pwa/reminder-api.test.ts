import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchReadyReminderList } from './reminder-api';

describe('fetchReadyReminderList', () => {
	afterEach(() => vi.useRealTimers());

	it('retries bounded cache-warming responses until the full list is ready', async () => {
		const apiFetch = vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ warming: true }), { status: 202 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ warming: true }), { status: 202 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ reminders: [] }), { status: 200 }));

		const response = await fetchReadyReminderList(apiFetch, '/reminders/list', new Headers());

		expect(response.status).toBe(200);
		expect(apiFetch).toHaveBeenCalledTimes(3);
	});

	it('stops after the warm-up request limit', async () => {
		const apiFetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ warming: true }), { status: 202 }),
		);

		await expect(fetchReadyReminderList(
			apiFetch,
			'/reminders/list',
			new Headers(),
		)).rejects.toThrow('Reminder index is still preparing. Try again in a moment.');
		expect(apiFetch).toHaveBeenCalledTimes(100);
	});

	it('caps the total server-requested warm-up delay', async () => {
		vi.useFakeTimers();
		const apiFetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ warming: true }), {
				status: 202,
				headers: { 'Retry-After': '5' },
			}),
		);

		const result = fetchReadyReminderList(apiFetch, '/reminders/list', new Headers());
		const rejection = expect(result).rejects.toThrow('Try again in a moment');
		await vi.advanceTimersByTimeAsync(15_000);
		await rejection;
		expect(apiFetch).toHaveBeenCalledTimes(4);
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

import { describe, expect, it, vi } from 'vitest';
import { fetchReadyReminderList } from './reminder-api';

describe('fetchReadyReminderList', () => {
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
		)).rejects.toThrow('Reminder index is taking too long to prepare');
		expect(apiFetch).toHaveBeenCalledTimes(100);
	});
});

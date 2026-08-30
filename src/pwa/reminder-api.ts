import type { ApiFetch } from './types';

const MAX_REMINDER_INDEX_WARMUP_REQUESTS = 100;

export async function fetchReadyReminderList(
	apiFetch: ApiFetch,
	path: string,
	headers: Headers,
): Promise<Response> {
	for (let attempt = 0; attempt < MAX_REMINDER_INDEX_WARMUP_REQUESTS; attempt += 1) {
		const response = await apiFetch(path, { headers });
		if (response.status !== 202) return response;
	}
	throw new Error('Reminder index is taking too long to prepare');
}

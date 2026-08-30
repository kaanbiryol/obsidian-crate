import type { ApiFetch } from './types';

const MAX_REMINDER_INDEX_WARMUP_REQUESTS = 100;
const MAX_REMINDER_INDEX_RETRY_DELAY_MS = 5_000;

function retryDelayMs(response: Response): number {
	const retryAfter = response.headers.get('Retry-After');
	if (!retryAfter) return 0;
	const seconds = Number(retryAfter);
	if (!Number.isFinite(seconds) || seconds <= 0) return 0;
	return Math.min(seconds * 1000, MAX_REMINDER_INDEX_RETRY_DELAY_MS);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function fetchReadyReminderList(
	apiFetch: ApiFetch,
	path: string,
	headers: Headers,
): Promise<Response> {
	for (let attempt = 0; attempt < MAX_REMINDER_INDEX_WARMUP_REQUESTS; attempt += 1) {
		const response = await apiFetch(path, { headers });
		if (response.status !== 202) return response;
		const waitMs = retryDelayMs(response);
		if (waitMs > 0) {
			await delay(waitMs);
		}
	}
	throw new Error('Reminder index is taking too long to prepare');
}

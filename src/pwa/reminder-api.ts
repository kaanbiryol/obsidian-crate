import type { ApiFetch, ReminderRecord, ReminderSourceIssue } from './types';
import { isReminderList } from './reminder-storage-validation';
import { parseReminderSourceIssues } from './reminder-source-issues';

/** Validate the complete revision before either the UI or its cache accepts it. */
export function parseReminderListResponse(value: unknown, folderPath: string): {
	reminders: ReminderRecord[]; projects: string[]; issues: ReminderSourceIssue[];
} | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const result = value as Record<string, unknown>;
	const issues = parseReminderSourceIssues(result.issues);
	if (!issues || !isReminderList(result.reminders, folderPath)
		|| !Array.isArray(result.projects) || !result.projects.every(project => typeof project === 'string')) return null;
	return { reminders: result.reminders, projects: result.projects, issues };
}

const MAX_REMINDER_INDEX_WARMUP_REQUESTS = 1000;
const MAX_REMINDER_INDEX_RETRY_DELAY_MS = 5_000;
const MAX_REMINDER_INDEX_TOTAL_WAIT_MS = 10 * 60_000;

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
	onProgress?: (remaining: number, total: number) => void,
): Promise<Response> {
	let totalWaitMs = 0;
	for (let attempt = 0; attempt < MAX_REMINDER_INDEX_WARMUP_REQUESTS; attempt += 1) {
		const response = await apiFetch(path, { headers });
		if (response.status !== 202) return response;
		const progress = await response.json() as { remainingFiles?: number; totalFiles?: number };
		onProgress?.(progress.remainingFiles ?? 0, progress.totalFiles ?? 0);
		const waitMs = retryDelayMs(response);
		if (waitMs > 0) {
			if (totalWaitMs + waitMs > MAX_REMINDER_INDEX_TOTAL_WAIT_MS) break;
			await delay(waitMs);
			totalWaitMs += waitMs;
		}
	}
	throw new Error('Reminder index is still preparing. Try again in a moment.');
}

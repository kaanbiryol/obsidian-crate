import type { ApiFetch, ReminderRecord, ReminderSourceIssue } from './types';
import { isReminderList } from './reminder-storage-validation';
import { parseReminderSourceIssues } from './reminder-source-issues';

export interface ReminderIndexingProgress {
	indexedFiles: number;
	totalFiles: number;
}

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

/** A delta replaces every reminder from `changedPaths` with `reminders`; other
 * notes keep the base snapshot's records. Validated as strictly as a full list. */
export function parseReminderDeltaResponse(value: unknown, folderPath: string): {
	changedPaths: string[]; reminders: ReminderRecord[]; projects: string[];
} | null {
	if (!value || typeof value !== 'object' || Array.isArray(value) || (value as { delta?: unknown }).delta !== true) return null;
	const result = value as Record<string, unknown>;
	const changedPaths = result.changedPaths;
	if (!Array.isArray(changedPaths) || !changedPaths.every(path => typeof path === 'string' && path.startsWith(`${folderPath}/`))
		|| !isReminderList(result.reminders, folderPath) || !Array.isArray(result.projects) || !result.projects.every(project => typeof project === 'string')
		|| !Array.isArray(result.issues) || result.issues.length) return null;
	const changed = new Set(changedPaths as string[]);
	if (!result.reminders.every(reminder => changed.has(reminder.filePath))) return null;
	return { changedPaths: changedPaths as string[], reminders: result.reminders, projects: result.projects };
}

/** Rebuild the full list in the server's order: notes by path, reminders by line. */
export function applyReminderDelta(base: ReminderRecord[], delta: { changedPaths: string[]; reminders: ReminderRecord[] }): ReminderRecord[] {
	const changed = new Set(delta.changedPaths);
	const notes = new Map<string, ReminderRecord[]>();
	for (const reminder of [...base.filter(reminder => !changed.has(reminder.filePath)), ...delta.reminders]) {
		const note = notes.get(reminder.filePath);
		if (note) note.push(reminder); else notes.set(reminder.filePath, [reminder]);
	}
	return [...notes.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0).flatMap(path => notes.get(path)!);
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

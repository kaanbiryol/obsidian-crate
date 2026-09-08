import type { ApiFetch, ReminderRecord } from './types';
import type { PendingReminderChange, ReminderChangeResult } from './reminder-outbox-types';

export class RejectedReminderChange extends Error {}

export function isConfirmedReminder(value: unknown, id: string | undefined): value is ReminderRecord {
	if (!value || typeof value !== 'object') return false;
	const record = value as Partial<ReminderRecord>;
	return record.id === id && typeof record.content === 'string' && typeof record.completed === 'boolean'
		&& typeof record.project === 'string' && typeof record.filePath === 'string'
		&& typeof record.revision === 'string' && (record.priority === 1 || record.priority === 4);
}

export async function submitReminderChange(apiFetch: ApiFetch, change: PendingReminderChange): Promise<ReminderChangeResult> {
	const response = await apiFetch(change.path, { method: change.method, body: change.body });
	if (!response.ok) {
		const text = await response.text();
		let details: { code?: string; error?: string } = {};
		try { details = JSON.parse(text) as typeof details; } catch { /* Proxies may return plain text. */ }
		const message = details.error || text || 'Could not sync this change.';
		if ([400, 403, 404, 409, 413, 428].includes(response.status) && details.code !== 'operation_mismatch') {
			throw new RejectedReminderChange(message);
		}
		throw new Error(message);
	}
	const result = await response.json() as ReminderChangeResult & { success?: boolean };
	if (change.kind === 'save' || change.kind === 'complete') {
		if (!isConfirmedReminder(result.reminder, change.recordId)) throw new Error('The server did not confirm this reminder. Retry to check the earlier change.');
	} else if (result.success !== true) throw new Error('The server did not confirm this change. Retry to check its status.');
	return result;
}

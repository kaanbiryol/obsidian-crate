import type { ApiFetch } from '../../types';
import type { ReminderRecord } from '../types';
import type { PendingReminderChange, ReminderChangeResult } from './reminder-outbox-types';
import { isReminderRecord } from '../cache/reminder-storage-validation';
import { responseError } from '../../connection/response-error';

export class RejectedReminderChange extends Error {}
export class ExpiredReminderChange extends Error {}

export function isConfirmedReminder(value: unknown, id: string | undefined): value is ReminderRecord {
	return isReminderRecord(value) && value.id === id && typeof value.revision === 'string';
}

export async function submitReminderChange(apiFetch: ApiFetch, change: PendingReminderChange): Promise<ReminderChangeResult> {
	const response = await apiFetch(change.path, { method: change.method, body: change.body });
	if (!response.ok) {
		// Saved with the pending change, so proxy pages become the short fallback.
		const { message, code } = await responseError(response, 'Could not sync this change.');
		if (response.status === 410 && code === 'operation_expired') throw new ExpiredReminderChange(message);
		if ([400, 403, 404, 409, 413, 428].includes(response.status) && code !== 'operation_mismatch') {
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

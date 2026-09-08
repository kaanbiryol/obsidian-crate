import { validateRecurrence } from '@/reminders/core/validateRecurrence';
import { isStoredReminderDraft } from './reminder-storage-validation';
import type { ModalState } from './types';

function object(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}
function filePath(value: unknown, folderPath: string): boolean {
	return value === undefined || typeof value === 'string' && value.startsWith(`${folderPath}/`)
		&& value.endsWith('.md') && !value.includes('\\')
		&& !value.split('/').some(part => !part || part === '.' || part === '..');
}

/** Validate retained attempts without rewriting their body or operation identity. */
export function isStoredReminderModal(value: unknown, folderPath: string): value is ModalState {
	if (!object(value) || !['create', 'edit'].includes(String(value.mode)) || !isStoredReminderDraft(value.draft)
		|| ['reminderId', 'operationId', 'expectedRevision'].some(key => value[key] !== undefined && typeof value[key] !== 'string')
		|| (value.recovery !== undefined && typeof value.recovery !== 'boolean') || !filePath(value.filePath, folderPath)) return false;
	if (value.pendingSave === undefined) return true;
	const pending = value.pendingSave;
	if (!object(pending) || !['/reminders/create', '/reminders/update'].includes(String(pending.path))
		|| typeof pending.body !== 'string' || typeof pending.draftKey !== 'string' || !object(pending.input)) return false;
	const input = pending.input;
	if (input.folderPath !== folderPath || typeof input.content !== 'string' || typeof input.project !== 'string'
		|| (input.priority !== 1 && input.priority !== 4) || ['description', 'dueDate', 'dueDatetime'].some(key => input[key] !== null && typeof input[key] !== 'string')
		|| (input.recurrence != null && 'error' in validateRecurrence(input.recurrence))) return false;
	try {
		const body: unknown = JSON.parse(pending.body);
		return object(body) && typeof body.id === 'string' && !!body.id && typeof body.operationId === 'string' && !!body.operationId
			&& body.folderPath === folderPath && filePath(body.filePath, folderPath);
	} catch { return false; }
}

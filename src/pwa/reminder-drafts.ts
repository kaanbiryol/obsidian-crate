import type { ModalDraft, ModalState } from './types';

const PREFIX = 'crate-reminder-draft:';
function key(modal: ModalState): string { return PREFIX + (modal.reminderId ?? 'new'); }
function validRecoveryDraft(value: unknown): value is ModalDraft {
	if (!value || typeof value !== 'object') return false;
	const draft = value as Partial<ModalDraft>;
	return ['content', 'description', 'project', 'defaultProject', 'dueDate', 'dueTime']
		.every(field => typeof draft[field as keyof ModalDraft] === 'string')
		&& (draft.priority === 1 || draft.priority === 4)
		&& (draft.activePicker === null || ['date', 'project', 'recurrence'].includes(String(draft.activePicker)))
		&& typeof draft.deleteConfirm === 'boolean';
}
export function saveReminderDraft(modal: ModalState): void {
	try { sessionStorage.setItem(key(modal), JSON.stringify(modal)); } catch { /* The open editor still retains the draft. */ }
}
export function restoreReminderDraft(initial: ModalState): ModalState {
	try {
		const saved = JSON.parse(sessionStorage.getItem(key(initial)) ?? 'null') as ModalState | null;
		if (initial.recovery) {
			if (initial.operationId && saved?.operationId === initial.operationId
				&& saved.mode === initial.mode && saved.reminderId === initial.reminderId
				&& validRecoveryDraft(saved.draft)) return { ...initial, draft: saved.draft };
			return initial;
		}
		if (saved?.mode === initial.mode && saved.reminderId === initial.reminderId && typeof saved.draft?.content === 'string') return saved;
	} catch { /* Ignore a damaged draft. */ }
	return initial;
}
export function discardReminderDraft(modal: ModalState): void {
	try { sessionStorage.removeItem(key(modal)); } catch { /* Best effort. */ }
}
export function clearReminderDrafts(): void {
	try {
		for (const entry of Object.keys(sessionStorage)) if (entry.startsWith(PREFIX)) sessionStorage.removeItem(entry);
	} catch { /* Storage may be unavailable. */ }
}

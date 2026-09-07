import type { ModalDraft, ModalState } from './types';

const PREFIX = 'crate-reminder-draft:';
function key(modal: ModalState, folderPath: string): string {
	return `${PREFIX}${encodeURIComponent(folderPath)}:${modal.reminderId ?? 'new'}`;
}
function validRecoveryDraft(value: unknown): value is ModalDraft {
	if (!value || typeof value !== 'object') return false;
	const draft = value as Partial<ModalDraft>;
	return ['content', 'description', 'project', 'defaultProject', 'dueDate', 'dueTime']
		.every(field => typeof draft[field as keyof ModalDraft] === 'string')
		&& (draft.priority === 1 || draft.priority === 4)
		&& (draft.activePicker === null || ['date', 'project', 'recurrence'].includes(String(draft.activePicker)))
		&& typeof draft.deleteConfirm === 'boolean';
}

/** Bind existing editor drafts before an enrollment link can change folders. */
export function scopeLegacyReminderDrafts(folderPath: string): void {
	for (const entry of Object.keys(sessionStorage)) {
		if (!entry.startsWith(PREFIX)) continue;
		const raw = sessionStorage.getItem(entry);
		let saved: (ModalState & { legacyFolderPath?: unknown }) | null;
		try { saved = JSON.parse(raw ?? 'null') as typeof saved; } catch { continue; }
		if (!saved || entry !== PREFIX + (saved.reminderId ?? 'new') || !validRecoveryDraft(saved.draft)
			|| (saved.legacyFolderPath !== undefined && saved.legacyFolderPath !== folderPath)
			|| (saved.filePath != null && (typeof saved.filePath !== 'string' || !saved.filePath.startsWith(`${folderPath}/`)))
			|| (saved.pendingSave && saved.pendingSave.input?.folderPath !== folderPath)) continue;
		const destination = key(saved, folderPath);
		const existing = sessionStorage.getItem(destination);
		if (existing !== null) {
			if (existing === raw) sessionStorage.removeItem(entry);
			// Retain both drafts on collision without letting a later folder
			// enrollment claim the older, otherwise unscoped create draft.
			else sessionStorage.setItem(entry, JSON.stringify({ ...saved, legacyFolderPath: folderPath }));
			continue;
		}
		sessionStorage.setItem(destination, raw!);
		sessionStorage.removeItem(entry);
	}
}

export function saveReminderDraft(modal: ModalState, folderPath: string): void {
	try { sessionStorage.setItem(key(modal, folderPath), JSON.stringify(modal)); } catch { /* The open editor still retains the draft. */ }
}
export function restoreReminderDraft(initial: ModalState, folderPath: string): ModalState {
	try {
		const saved = JSON.parse(sessionStorage.getItem(key(initial, folderPath)) ?? 'null') as ModalState | null;
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
export function discardReminderDraft(modal: ModalState, folderPath: string): void {
	try { sessionStorage.removeItem(key(modal, folderPath)); } catch { /* Best effort. */ }
}
export function clearReminderDrafts(): void {
	try {
		for (const entry of Object.keys(sessionStorage)) if (entry.startsWith(PREFIX)) sessionStorage.removeItem(entry);
	} catch { /* Storage may be unavailable. */ }
}

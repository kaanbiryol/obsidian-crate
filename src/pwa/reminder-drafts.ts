import type { ModalState } from './types';

const PREFIX = 'crate-reminder-draft:';
function key(modal: ModalState): string { return PREFIX + (modal.reminderId ?? 'new'); }
export function saveReminderDraft(modal: ModalState): void {
	try { sessionStorage.setItem(key(modal), JSON.stringify(modal)); } catch { /* The open editor still retains the draft. */ }
}
export function restoreReminderDraft(initial: ModalState): ModalState {
	try {
		const saved = JSON.parse(sessionStorage.getItem(key(initial)) ?? 'null') as ModalState | null;
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

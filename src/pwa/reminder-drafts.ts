import type { ModalState } from './types';
import { isStoredReminderDraft } from './reminder-storage-validation';
import { isStoredReminderModal } from './reminder-draft-validation';

const PREFIX = 'crate-reminder-draft:';
function key(modal: ModalState, folderPath: string): string {
	return `${PREFIX}${encodeURIComponent(folderPath)}:${modal.reminderId ?? 'new'}`;
}

/** Bind existing editor drafts before an enrollment link can change folders. */
export function scopeLegacyReminderDrafts(folderPath: string): void {
	for (const entry of Object.keys(sessionStorage)) {
		if (!entry.startsWith(PREFIX)) continue;
		const raw = sessionStorage.getItem(entry);
		let saved: (ModalState & { legacyFolderPath?: unknown }) | null;
		try { saved = JSON.parse(raw ?? 'null') as typeof saved; } catch { continue; }
		if (!saved || entry !== PREFIX + (saved.reminderId ?? 'new') || !isStoredReminderDraft(saved.draft)
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
	return inspectReminderDraft(initial, folderPath).modal;
}

export function inspectReminderDraft(initial: ModalState, folderPath: string): {
	modal: ModalState; recovery?: { key: string; raw: string }; unavailable?: boolean;
} {
	let raw: string | null;
	const storageKey = key(initial, folderPath);
	try { raw = sessionStorage.getItem(storageKey); } catch { return { modal: initial, unavailable: true }; }
	if (raw === null) return { modal: initial };
	try {
		const saved: unknown = JSON.parse(raw);
		if (isStoredReminderModal(saved, folderPath) && saved.mode === initial.mode && saved.reminderId === initial.reminderId) {
			if (!initial.recovery) return { modal: saved };
			if (initial.operationId && saved.operationId === initial.operationId) return { modal: { ...initial, draft: saved.draft } };
		}
	} catch { /* Preserve the complete original string for review/export. */ }
	return { modal: initial, recovery: { key: storageKey, raw } };
}

export function discardReviewedReminderDraft(entry: { key: string; raw: string }, initial: ModalState, folderPath: string): void {
	if (entry.key !== key(initial, folderPath) || sessionStorage.getItem(entry.key) !== entry.raw) {
		throw new Error('The saved draft changed. Close and reopen it to review the current copy.');
	}
	sessionStorage.removeItem(entry.key);
	if (sessionStorage.getItem(entry.key) !== null) throw new Error('The saved draft could not be removed. Try again.');
}
export function discardReminderDraft(modal: ModalState, folderPath: string): void {
	try { sessionStorage.removeItem(key(modal, folderPath)); } catch { /* Best effort. */ }
}
export function clearReminderDrafts(): void {
	try {
		for (const entry of Object.keys(sessionStorage)) if (entry.startsWith(PREFIX)) sessionStorage.removeItem(entry);
	} catch { /* Storage may be unavailable. */ }
}

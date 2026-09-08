import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discardReviewedReminderDraft, inspectReminderDraft, restoreReminderDraft, saveReminderDraft, scopeLegacyReminderDrafts } from './reminder-drafts';
import type { ModalState } from './types';

function modal(patch: Partial<ModalState> = {}): ModalState {
	return {
		mode: 'edit', reminderId: 'reminder', operationId: 'recovery-operation', recovery: true,
		expectedRevision: 'current-revision', filePath: 'Reminders/Current.md',
		draft: { content: 'Recover this reminder', description: 'Keep these details', project: 'Inbox', defaultProject: 'Inbox', priority: 4, dueDate: '', dueTime: '', activePicker: null, deleteConfirm: false },
		...patch,
	};
}

beforeEach(() => {
	const values: Record<string, string> = {};
	vi.stubGlobal('sessionStorage', Object.defineProperties(values, {
		getItem: { value: (key: string) => values[key] ?? null },
		setItem: { value: (key: string, value: string) => { values[key] = value; } },
		removeItem: { value: (key: string) => { delete values[key]; } },
	}));
});
afterEach(() => vi.unstubAllGlobals());

describe('recovered reminder drafts', () => {
	it.each([{ description: { lost: 'Important unsaved details' } }, { recurrence: { frequency: 'broken' } }, { originalDueDatetime: {} }])('does not pass damaged stored fields into the editor: %j', patch => {
		const initial = modal({ recovery: false });
		const raw = JSON.stringify({ ...initial, draft: { ...initial.draft, ...patch } });
		sessionStorage.setItem('crate-reminder-draft:Reminders:reminder', raw);
		expect(restoreReminderDraft(initial, 'Reminders')).toEqual(initial);
		expect(sessionStorage.getItem('crate-reminder-draft:Reminders:reminder')).toBe(raw);
		expect(inspectReminderDraft(initial, 'Reminders').recovery).toEqual({ key: 'crate-reminder-draft:Reminders:reminder', raw });
	});
	it('requires review for invalid JSON and refuses changed, failed or cross-folder removal', () => {
		const initial = modal({ recovery: false });
		const key = 'crate-reminder-draft:Reminders:reminder';
		sessionStorage.setItem(key, '{broken');
		const entry = inspectReminderDraft(initial, 'Reminders').recovery!;
		expect(entry.raw).toBe('{broken');
		expect(() => discardReviewedReminderDraft(entry, initial, 'Private')).toThrow('changed');
		sessionStorage.setItem(key, '{changed');
		expect(() => discardReviewedReminderDraft(entry, initial, 'Reminders')).toThrow('changed');
		expect(sessionStorage.getItem(key)).toBe('{changed');
		discardReviewedReminderDraft({ key, raw: '{changed' }, initial, 'Reminders');
		expect(sessionStorage.getItem(key)).toBeNull();
	});
	it('keeps an unrelated valid draft reviewable before opening operation recovery', () => {
		const initial = modal();
		saveReminderDraft(modal({ operationId: 'another-operation' }), 'Reminders');
		expect(inspectReminderDraft(initial, 'Reminders').recovery).toBeDefined();
	});
	it.each([{ pendingSave: { path: '/danger', body: '{}', input: {} } }, { filePath: 'Private/Inbox.md' }])('quarantines malformed or out-of-folder attempt metadata: %j', patch => {
		const initial = modal({ recovery: false });
		sessionStorage.setItem('crate-reminder-draft:Reminders:reminder', JSON.stringify({ ...initial, ...patch }));
		expect(inspectReminderDraft(initial, 'Reminders').recovery).toBeDefined();
	});
	it('keeps colliding legacy create drafts bound to their original folder', () => {
		const initial = modal({ mode: 'create', reminderId: undefined, filePath: undefined, recovery: false });
		const older = { ...initial, draft: { ...initial.draft, content: 'Older unsaved text' } };
		sessionStorage.setItem('crate-reminder-draft:new', JSON.stringify(older));
		saveReminderDraft(initial, 'Reminders');
		scopeLegacyReminderDrafts('Reminders');
		scopeLegacyReminderDrafts('Private');
		expect(sessionStorage.getItem('crate-reminder-draft:Private:new')).toBeNull();
		expect(restoreReminderDraft(initial, 'Reminders')).toEqual(initial);
		const retained = JSON.parse(sessionStorage.getItem('crate-reminder-draft:new')!) as ModalState;
		expect(retained.draft.content).toBe('Older unsaved text');
	});
	it('binds legacy drafts to their original folder and skips damaged command metadata', () => {
		const initial = modal({ recovery: false });
		sessionStorage.setItem('crate-reminder-draft:reminder', JSON.stringify(initial));
		sessionStorage.setItem('crate-reminder-draft:damaged-command', JSON.stringify({ ...initial, reminderId: 'damaged-command', pendingSave: {} }));
		sessionStorage.setItem('crate-reminder-draft:damaged-path', JSON.stringify({ ...initial, reminderId: 'damaged-path', filePath: 42 }));
		expect(() => scopeLegacyReminderDrafts('Reminders')).not.toThrow();
		expect(sessionStorage.getItem('crate-reminder-draft:reminder')).toBeNull();
		expect(sessionStorage.getItem('crate-reminder-draft:Reminders:reminder')).toBe(JSON.stringify(initial));
		expect(restoreReminderDraft(initial, 'Reminders')).toEqual(initial);
		expect(sessionStorage.getItem('crate-reminder-draft:Private:reminder')).toBeNull();
		expect(sessionStorage.getItem('crate-reminder-draft:damaged-command')).not.toBeNull();
		expect(sessionStorage.getItem('crate-reminder-draft:damaged-path')).not.toBeNull();
	});
	it('retains same-folder drafts while isolating another enrolled folder', () => {
		const initial = modal({ recovery: false });
		const saved = modal({ recovery: false, draft: { ...initial.draft, content: 'My retained text' } });
		saveReminderDraft(saved, 'Reminders');
		expect(restoreReminderDraft(initial, 'Private')).toEqual(initial);
		expect(restoreReminderDraft(initial, 'Reminders')).toEqual(saved);
	});
	it('does not replace a deleted reminder recovery with an unrelated new draft', () => {
		const initial = modal({ mode: 'create', reminderId: undefined });
		saveReminderDraft(modal({ mode: 'create', reminderId: undefined, operationId: 'unrelated-operation', draft: { ...initial.draft, content: 'Unrelated unsaved reminder' } }), 'Reminders');
		expect(restoreReminderDraft(initial, 'Reminders')).toEqual(initial);
	});

	it('restores same-operation text while preserving current recovery identity and revision', () => {
		const initial = modal();
		const saved = modal({ expectedRevision: 'stale-revision', filePath: 'Reminders/Old.md', recovery: false,
			draft: { ...initial.draft, content: 'My unfinished correction', description: 'More details' } });
		saveReminderDraft(saved, 'Reminders');
		expect(restoreReminderDraft(initial, 'Reminders')).toEqual({ ...initial, draft: saved.draft });
	});

	it.each([
		{ operationId: 'different-operation' },
		{ mode: 'create' as const },
		{ draft: { content: 'Incomplete saved draft' } as ModalState['draft'] },
	])('ignores incompatible or damaged recovery drafts: %j', patch => {
		const initial = modal();
		saveReminderDraft(modal(patch), 'Reminders');
		expect(restoreReminderDraft(initial, 'Reminders')).toEqual(initial);
	});

	it('keeps legacy attempted commands intact when restoring an ordinary editor', () => {
		const saved = modal({ recovery: false, pendingSave: {
			path: '/reminders/update', body: '{ "operationId":"original-attempt", "id":"reminder", "folderPath":"Reminders" }', draftKey: 'original-draft',
			input: { folderPath: 'Reminders', content: 'Original attempt', description: null, project: 'Inbox', priority: 4, dueDate: null, dueDatetime: null },
		} });
		saveReminderDraft(saved, 'Reminders');
		expect(restoreReminderDraft(modal({ recovery: false, operationId: 'new-opening' }), 'Reminders')).toEqual(saved);
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discardReviewedReminderDraft, inspectReminderDraft, restoreReminderDraft, saveReminderDraft } from './reminder-drafts';
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
	it.each([{ filePath: 'Private/Inbox.md' }])('quarantines malformed or out-of-folder attempt metadata: %j', patch => {
		const initial = modal({ recovery: false });
		sessionStorage.setItem('crate-reminder-draft:Reminders:reminder', JSON.stringify({ ...initial, ...patch }));
		expect(inspectReminderDraft(initial, 'Reminders').recovery).toBeDefined();
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

});

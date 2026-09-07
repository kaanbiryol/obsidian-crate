import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreReminderDraft, saveReminderDraft } from './reminder-drafts';
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
	const values = new Map<string, string>();
	vi.stubGlobal('sessionStorage', {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	});
});
afterEach(() => vi.unstubAllGlobals());

describe('recovered reminder drafts', () => {
	it('does not replace a deleted reminder recovery with an unrelated new draft', () => {
		const initial = modal({ mode: 'create', reminderId: undefined });
		saveReminderDraft(modal({ mode: 'create', reminderId: undefined, operationId: 'unrelated-operation', draft: { ...initial.draft, content: 'Unrelated unsaved reminder' } }));
		expect(restoreReminderDraft(initial)).toEqual(initial);
	});

	it('restores same-operation text while preserving current recovery identity and revision', () => {
		const initial = modal();
		const saved = modal({ expectedRevision: 'stale-revision', filePath: 'Reminders/Old.md', recovery: false,
			draft: { ...initial.draft, content: 'My unfinished correction', description: 'More details' } });
		saveReminderDraft(saved);
		expect(restoreReminderDraft(initial)).toEqual({ ...initial, draft: saved.draft });
	});

	it.each([
		{ operationId: 'different-operation' },
		{ mode: 'create' as const },
		{ draft: { content: 'Incomplete saved draft' } as ModalState['draft'] },
	])('ignores incompatible or damaged recovery drafts: %j', patch => {
		const initial = modal();
		saveReminderDraft(modal(patch));
		expect(restoreReminderDraft(initial)).toEqual(initial);
	});

	it('keeps legacy attempted commands intact when restoring an ordinary editor', () => {
		const saved = modal({ recovery: false, pendingSave: {
			path: '/reminders/update', body: '{"operationId":"original-attempt"}', draftKey: 'original-draft',
			input: { folderPath: 'Reminders', content: 'Original attempt', description: null, project: 'Inbox', priority: 4, dueDate: null, dueDatetime: null },
		} });
		saveReminderDraft(saved);
		expect(restoreReminderDraft(modal({ recovery: false, operationId: 'new-opening' }))).toEqual(saved);
	});
});

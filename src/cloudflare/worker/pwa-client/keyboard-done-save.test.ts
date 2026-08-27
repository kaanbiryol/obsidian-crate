import { describe, expect, it } from 'vitest';
import { shouldSaveFromKeyboardDone, type KeyboardDoneSaveState } from './keyboard-done-save';

const DONE_DISMISS: KeyboardDoneSaveState = {
	canSubmit: true,
	documentHasFocus: true,
	documentIsVisible: true,
	hadRecentPagePointer: false,
	hasEditorFocus: false,
	relatedTargetWasNull: true,
};

describe('keyboard Done save detection', () => {
	it('saves when the iOS keyboard dismisses an otherwise active editor', () => {
		expect(shouldSaveFromKeyboardDone(DONE_DISMISS)).toBe(true);
	});

	it.each([
		['the reminder is empty or busy', { canSubmit: false }],
		['focus moves between editor fields', { hasEditorFocus: true }],
		['focus moves to another control', { relatedTargetWasNull: false }],
		['a page control caused the blur', { hadRecentPagePointer: true }],
		['the document loses focus', { documentHasFocus: false }],
		['the document becomes hidden', { documentIsVisible: false }],
	])('does not save when %s', (_label, patch) => {
		expect(shouldSaveFromKeyboardDone({ ...DONE_DISMISS, ...patch })).toBe(false);
	});
});

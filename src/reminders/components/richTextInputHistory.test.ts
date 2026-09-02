import { describe, expect, it } from 'vitest';
import {
	getRichTextHistoryAction,
	RichTextInputHistory,
	type RichTextHistorySnapshot,
} from './richTextInputHistory';

const snapshot = (value: string, cursor = value.length): RichTextHistorySnapshot => ({
	value,
	cursor,
});

describe('RichTextInputHistory', () => {
	it('undoes and redoes recorded edits with their caret positions', () => {
		const history = new RichTextInputHistory(snapshot(''));

		history.capture(snapshot(''));
		history.record(snapshot('a'));
		history.capture(snapshot('a'));
		history.record(snapshot('ab'));

		expect(history.undo(snapshot('ab'))).toEqual(snapshot('a'));
		expect(history.undo(snapshot('a'))).toEqual(snapshot(''));
		expect(history.redo(snapshot(''))).toEqual(snapshot('a'));
		expect(history.redo(snapshot('a'))).toEqual(snapshot('ab'));
	});

	it('clears redo history when typing resumes after undo', () => {
		const history = new RichTextInputHistory(snapshot(''));

		history.capture(snapshot(''));
		history.record(snapshot('a'));
		history.capture(snapshot('a'));
		history.record(snapshot('ab'));
		expect(history.undo(snapshot('ab'))).toEqual(snapshot('a'));

		history.capture(snapshot('a'));
		history.record(snapshot('ac'));
		expect(history.redo(snapshot('ac'))).toBeNull();
		expect(history.undo(snapshot('ac'))).toEqual(snapshot('a'));
	});

	it('resets stale history for an external value change', () => {
		const history = new RichTextInputHistory(snapshot('draft'));

		history.capture(snapshot('draft'));
		history.record(snapshot('draft!'));
		history.reset(snapshot('another reminder'));

		expect(history.undo(snapshot('another reminder'))).toBeNull();
	});
});

describe('getRichTextHistoryAction', () => {
	const keyboardEvent = (overrides: Partial<Parameters<typeof getRichTextHistoryAction>[0]>) => ({
		key: '',
		metaKey: false,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		...overrides,
	});

	it('recognizes macOS undo and redo shortcuts', () => {
		expect(getRichTextHistoryAction(keyboardEvent({ key: 'z', metaKey: true }))).toBe('undo');
		expect(getRichTextHistoryAction(keyboardEvent({
			key: 'Z',
			metaKey: true,
			shiftKey: true,
		}))).toBe('redo');
	});

	it('recognizes Windows and Linux undo and redo shortcuts', () => {
		expect(getRichTextHistoryAction(keyboardEvent({ key: 'z', ctrlKey: true }))).toBe('undo');
		expect(getRichTextHistoryAction(keyboardEvent({ key: 'y', ctrlKey: true }))).toBe('redo');
	});

	it('does not claim unrelated modified shortcuts', () => {
		expect(getRichTextHistoryAction(keyboardEvent({ key: 'z', metaKey: true, altKey: true }))).toBeNull();
		expect(getRichTextHistoryAction(keyboardEvent({ key: 'x', metaKey: true }))).toBeNull();
	});
});

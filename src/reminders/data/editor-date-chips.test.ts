import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { reminderDateRanges } from './editor-date-chips';
import { reminderDateDisplay } from './reminder-date-display';

const now = new Date('2026-11-14T12:00:00.000Z');

function shown(doc: string, selection: EditorSelection) {
	const state = EditorState.create({ doc, selection, extensions: EditorState.allowMultipleSelections.of(true) });
	return reminderDateRanges(state, [{ from: 0, to: doc.length }], text => reminderDateDisplay(text, now))
		.map(display => `${display.kind}:${doc.slice(display.from, display.to)}`);
}

describe('reminder dates in the editor', () => {
	it('shows the stored text on lines with a cursor or selection', () => {
		const doc = '- [ ] One 2026-12-01\n- [ ] Two 2026-12-02\n- [ ] Three 2026-12-03';
		expect(shown(doc, EditorSelection.single(doc.indexOf('Two')))).toEqual(['chip:2026-12-01', 'chip:2026-12-03']);
		expect(shown(doc, EditorSelection.single(doc.indexOf('One'), doc.indexOf('Two')))).toEqual(['chip:2026-12-03']);
	});

	it('keeps typed and invalid phrases visible on the line being typed', () => {
		const doc = '- [ ] Call Mia 2026-12-24\n- [ ] Water plants every 0 days';
		expect(shown(doc, EditorSelection.single(doc.length))).toEqual(['chip:2026-12-24', 'error:every 0 days']);
	});
});

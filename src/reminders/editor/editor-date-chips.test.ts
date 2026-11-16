import { describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { createReminderDateChips, datePhraseField, editDateChip, leavePhrase, openDateChip, reminderDateRanges } from './editor-date-chips';
import { normalizeReminderScheduleLine } from '../core/normalizeReminderSchedule';
import { reminderLineDisplays } from './reminder-date-display';

const now = new Date('2026-11-14T12:00:00.000Z');

function shown(doc: string, selection: EditorSelection) {
	const state = EditorState.create({ doc, selection, extensions: EditorState.allowMultipleSelections.of(true) });
	return reminderDateRanges(state, [{ from: 0, to: doc.length }], text => reminderLineDisplays(text, now))
		.map(display => `${display.kind === 'chip' && display.typed ? 'typed ' : ''}${display.kind}:${doc.slice(display.from, display.to)}`);
}

describe('reminder dates in the editor', () => {
	it('always shows a saved date as a chip, whatever is selected', () => {
		const doc = '- [ ] One 2026-12-01\n- [ ] Two 2026-12-02\n- [ ] Three 2026-12-03';
		const all = ['chip:2026-12-01', 'chip:2026-12-02', 'chip:2026-12-03'];
		expect(shown(doc, EditorSelection.single(doc.indexOf('Two')))).toEqual(all);
		expect(shown(doc, EditorSelection.single(doc.indexOf('2026-12-02') + 4))).toEqual(all);
		expect(shown(doc, EditorSelection.single(doc.indexOf('One'), doc.indexOf('Two')))).toEqual(all);
	});

	it('turns a saved date into a phrase to edit when deleting into its chip', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(now);
		try {
			const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12, 0).toISOString();
			const line = `- [ ] Call Mia ${tomorrow} <!-- crate-id:a -->`;
			const start = line.indexOf(tomorrow), end = start + tomorrow.length;
			const edit = (from: number, to: number, userEvent: string) => {
				const state = EditorState.create({ doc: line, selection: { anchor: userEvent === 'delete.backward' ? to : from } });
				const spec = editDateChip(state.update({ changes: { from, to }, userEvent }), now);
				return spec && state.update(spec).state;
			};
			// The editor deletes a chip as one, so a backspace covers all of it.
			const backward = edit(start, end, 'delete.backward')!;
			expect(backward.doc.toString()).toBe('- [ ] Call Mia tomorrow 12:00 <!-- crate-id:a -->');
			expect(backward.selection.main.head).toBe(start + 'tomorrow 12:00'.length);
			expect(edit(start, start + 1, 'delete.forward')!.selection.main.head).toBe(start);
			// Saving the phrase gives back the same line.
			expect(normalizeReminderScheduleLine(backward.doc.toString())).toBe(line);
			// Deletes elsewhere on the line are left alone.
			expect(edit(6, 7, 'delete.backward')).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('turns a saved date into a phrase when the cursor moves next to its chip', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(now);
		try {
			const doc = '- [ ] Pay rent 2026-12-01 <!-- crate-id:a -->';
			const from = doc.indexOf('2026'), to = from + '2026-12-01'.length;
			const move = (start: number, head: number) => {
				const state = EditorState.create({ doc, selection: { anchor: head } });
				const spec = openDateChip(state, EditorSelection.single(start), now);
				return spec && state.update(spec).state;
			};
			// A click at the end of the line lands after the chip.
			const clicked = move(0, to)!;
			expect(clicked.doc.toString()).toBe('- [ ] Pay rent Dec 1 <!-- crate-id:a -->');
			expect(clicked.selection.main.head).toBe(from + 'Dec 1'.length);
			// ArrowLeft across the chip keeps the cursor at the end; reaching its start from before stays at the start.
			expect(move(to, from)!.selection.main.head).toBe(from + 'Dec 1'.length);
			expect(move(from - 1, from)!.selection.main.head).toBe(from);
			// The line's end sits past the hidden ID, which shows right after the chip.
			const ended = move(0, doc.length)!;
			expect(ended.doc.toString()).toBe('- [ ] Pay rent Dec 1 <!-- crate-id:a -->');
			expect(ended.selection.main.head).toBe(from + 'Dec 1'.length);
			expect(move(doc.length, doc.length)).toBeNull();
			// Elsewhere on the line, or a selection, leaves the chip alone.
			expect(move(to, 6)).toBeNull();
			expect(openDateChip(EditorState.create({ doc, selection: { anchor: from - 3, head: to } }), EditorSelection.single(0), now)).toBeNull();
			expect(move(to, to)).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('restores the stored date when its phrase is left unchanged, and saves an edited one', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(now);
		try {
			const doc = '- [ ] Pay rent 2026-12-01 <!-- crate-id:a -->\nNext';
			const state = EditorState.create({ doc, selection: { anchor: doc.indexOf(' <!--') }, extensions: createReminderDateChips(() => true, () => undefined) });
			const opened = state.update(openDateChip(state, EditorSelection.single(0), now)!).state;
			expect(opened.doc.line(1).text).toBe('- [ ] Pay rent Dec 1 <!-- crate-id:a -->');
			const phrase = opened.field(datePhraseField)!;
			const apply = (from: typeof opened) => from.update({ changes: leavePhrase(from, from.field(datePhraseField)!).changes }).state.doc.line(1).text;
			expect(apply(opened)).toBe('- [ ] Pay rent 2026-12-01 <!-- crate-id:a -->');
			const edited = opened.update({ changes: { from: phrase.from, to: phrase.to, insert: 'Dec 3' } }).state;
			expect(apply(edited)).toBe('- [ ] Pay rent 2026-12-03 <!-- crate-id:a -->');
		} finally {
			vi.useRealTimers();
		}
	});

	it('edits a past date as its stored text, which is its only phrase', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(now);
		try {
			const doc = '- [ ] Plan next week 2026-10-09 <!-- crate-id:a -->\nNext';
			const end = doc.indexOf(' <!--');
			const state = EditorState.create({ doc, selection: { anchor: end }, extensions: createReminderDateChips(() => true, () => undefined) });
			const opened = state.update(openDateChip(state, EditorSelection.single(0), now)!).state;
			expect(opened.doc.toString()).toBe(doc);
			// The open phrase shows as text to edit, not as the chip it was.
			expect(reminderDateRanges(opened, [{ from: 0, to: doc.length }], text => reminderLineDisplays(text, now))).toEqual([]);
			const deleted = opened.update({ changes: { from: end - 1, to: end }, selection: { anchor: end - 1 }, userEvent: 'delete.backward' }).state;
			expect(deleted.doc.line(1).text).toBe('- [ ] Plan next week 2026-10-0 <!-- crate-id:a -->');
		} finally {
			vi.useRealTimers();
		}
	});

	it('deletes a date whole when no phrase gives it back', () => {
		// Phrases name minutes, so a time with seconds has none that saves back to it.
		const stored = '2026-12-01T09:00:30.000Z', doc = `- [ ] Pay rent ${stored} <!-- crate-id:a -->`;
		const state = EditorState.create({ doc });
		const end = doc.indexOf(stored) + stored.length;
		const spec = editDateChip(state.update({ changes: { from: end - 1, to: end }, userEvent: 'delete.backward' }), now);
		expect(spec && state.update(spec).state.doc.toString()).toBe('- [ ] Pay rent  <!-- crate-id:a -->');
	});

	it('marks a title’s important marker, not other exclamation marks or one in its description', () => {
		const doc = '- [ ] Wow! Publish ! 2026-12-01 <!-- crate-id:a -->\n- [ ] Pay rent // urgent !\n- [ ] [Hi ! there](https://example.com)\n! Not a task';
		expect(shown(doc, EditorSelection.single(0))).toEqual(['important:!', 'chip:2026-12-01', 'description: // urgent !']);
	});

	it('keeps typed and invalid phrases visible on the line being typed', () => {
		const doc = '- [ ] Call Mia 2026-12-24\n- [ ] Water plants every 0 days';
		expect(shown(doc, EditorSelection.single(doc.length))).toEqual(['chip:2026-12-24', 'error:every 0 days']);
	});

	it('shows the date as a chip while a description is typed after it', () => {
		const doc = '- [ ] Call Mia tomorrow 12:00 // bring receipts\n- [ ] Pay rent 2026-12-01 // online';
		const description = (line: string) => doc.indexOf(line) + line.length;
		const chips = ['typed chip:tomorrow 12:00', 'description: // bring receipts', 'chip:2026-12-01', 'description: // online'];
		expect(shown(doc, EditorSelection.single(description('bring receipts')))).toEqual(chips);
		expect(shown(doc, EditorSelection.single(description('online')))).toEqual(chips);
		// The end of the title is still the title.
		expect(shown(doc, EditorSelection.single(doc.indexOf(' // bring'))))
			.toEqual(['phrase:tomorrow 12:00', 'description: // bring receipts', 'chip:2026-12-01', 'description: // online']);
	});

	it('keeps an invalid date marked while a description is typed', () => {
		const doc = '- [ ] Water plants every 0 days // back porch\nNext';
		expect(shown(doc, EditorSelection.single(doc.length))).toEqual(['error:every 0 days', 'description: // back porch']);
	});

	it('places a description on a later line at its own position', () => {
		const doc = '- [ ] Pay rent 2026-12-01\n- [ ] Call Mia // bring receipts';
		const state = EditorState.create({ doc, selection: EditorSelection.single(0) });
		const description = reminderDateRanges(state, [{ from: 0, to: doc.length }], text => reminderLineDisplays(text, now)).find(found => found.kind === 'description');
		expect(description?.kind === 'description' && doc.slice(description.start, description.to)).toBe('bring receipts');
	});

	it('marks each further separator in a description as a new line', () => {
		const doc = '- [ ] Call Mia // one // two';
		const state = EditorState.create({ doc, selection: EditorSelection.single(doc.length) });
		const description = reminderDateRanges(state, [{ from: 0, to: doc.length }], text => reminderLineDisplays(text, now)).find(found => found.kind === 'description');
		expect(description?.kind === 'description' && description.breaks.map(position => doc.slice(position))).toEqual([' // two']);
	});

	it('switches to the description as soon as the separator is typed', () => {
		const doc = '- [ ] Call Mia tomorrow 12:00 //';
		expect(shown(doc, EditorSelection.single(doc.length))).toEqual(['typed chip:tomorrow 12:00', 'description: //']);
		expect(shown(`${doc} `, EditorSelection.single(doc.length + 1))).toEqual(['typed chip:tomorrow 12:00', 'description: // ']);
	});
});

import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import { hiddenReminderIdRanges, protectReminderIdMarker, reminderIdChangesForLeftLines } from './editor-line-leave';

const ID = /^- \[ \] (.+) <!-- crate-id:[0-9a-f-]{36} -->$/;

/** Applies `spec` to a document with the cursor at `cursor`, then the ID changes for the lines it left. */
function leave(text: string, cursor: number, spec: TransactionSpec, { wasFocused = true, isFocused = true } = {}) {
	const startState = EditorState.create({ doc: text, selection: EditorSelection.cursor(cursor) });
	const transaction = startState.update(spec);
	const changes = reminderIdChangesForLeftLines({ startState, state: transaction.state, changes: transaction.changes, wasFocused, isFocused });
	return transaction.state.update({ changes }).state.doc.toString().split('\n');
}

describe('reminder IDs on line leave', () => {
	it('adds the ID to the line Enter left, not the new line', () => {
		const text = '- [ ] Buy milk';
		const [left, next] = leave(text, text.length, { changes: { from: text.length, insert: '\n- [ ] ' }, selection: { anchor: text.length + 7 } });
		expect(left).toMatch(ID);
		expect(left!.match(ID)![1]).toBe('Buy milk');
		expect(next).toBe('- [ ] ');
	});

	it('adds the ID when the cursor moves to another line or the editor blurs', () => {
		const text = '- [ ] Call Sam\nNotes';
		expect(leave(text, 5, { selection: { anchor: text.length } })[0]).toMatch(ID);
		expect(leave(text, 5, {}, { isFocused: false })[0]).toMatch(ID);
	});

	it('leaves the line while the cursor stays on it', () => {
		const text = '- [ ] Call Sam';
		expect(leave(text, 5, { selection: { anchor: 9 } })).toEqual([text]);
	});

	it('keeps existing IDs, plain lines and code blocks for the scan', () => {
		const kept = '- [ ] Kept <!-- crate-id:kept -->';
		expect(leave(`${kept}\nx`, 0, { selection: { anchor: kept.length + 1 } })[0]).toBe(kept);
		expect(leave('Plain text\nx', 0, { selection: { anchor: 11 } })[0]).toBe('Plain text');
		expect(leave('```\n- [ ] Code\n```', 5, { selection: { anchor: 0 } })[1]).toBe('- [ ] Code');
	});

	it('does nothing for an editor that was not focused', () => {
		const text = '- [ ] Call Sam\nNotes';
		expect(leave(text, 5, { selection: { anchor: text.length } }, { wasFocused: false })[0]).toBe('- [ ] Call Sam');
	});
});

describe('reminder ID marker hiding', () => {
	const doc = '- [ ] Buy milk <!-- crate-id:a -->\nNotes\n- [ ] Call Sam <!-- crate-id:b -->';

	function hidden(cursor: number, visible = [{ from: 0, to: doc.length }]) {
		const state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor) });
		return hiddenReminderIdRanges(state, visible).map(({ from, to }) => doc.slice(from, to));
	}

	it('hides every marker with its leading space, including the cursor line', () => {
		expect(hidden(3)).toEqual([' <!-- crate-id:a -->', ' <!-- crate-id:b -->']);
	});

	it('hides a line shared by adjacent visible ranges once', () => {
		expect(hidden(doc.indexOf('Notes'), [{ from: 0, to: 5 }, { from: 5, to: doc.length }])).toEqual([' <!-- crate-id:a -->', ' <!-- crate-id:b -->']);
	});
});

describe('reminder ID marker protection', () => {
	const line = '- [ ] Buy milk <!-- crate-id:a -->';
	const end = line.indexOf(' <!--');

	function edit(doc: string, cursor: number, spec: TransactionSpec) {
		const state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor), extensions: EditorState.transactionFilter.of(protectReminderIdMarker) });
		const next = state.update(spec).state;
		return { text: next.doc.toString(), cursor: next.selection.main.head };
	}

	it('keeps the cursor in front of the marker', () => {
		expect(edit(line, 0, { selection: { anchor: line.length } }).cursor).toBe(end);
	});

	it('splits Enter after the marker so the ID stays on its reminder', () => {
		const { text, cursor } = edit(line, end, { changes: { from: end, insert: '\n- [ ] ' }, userEvent: 'input' });
		expect(text).toBe(`${line}\n- [ ] `);
		expect(cursor).toBe(text.length);
	});

	it('types in front of the marker and keeps it when a selection reaches into it', () => {
		expect(edit(line, end, { changes: { from: line.length, insert: '!' }, userEvent: 'input.type' }).text).toBe('- [ ] Buy milk! <!-- crate-id:a -->');
		expect(edit(line, 6, { changes: { from: 6, to: line.length, insert: 'Call Sam' }, userEvent: 'input.type' }).text).toBe('- [ ] Call Sam <!-- crate-id:a -->');
	});

	it('joins the next line instead of deleting the marker alone', () => {
		expect(edit(`${line}\nNext`, end, { changes: { from: end, to: line.length }, userEvent: 'delete.forward' }).text).toBe(`${line}Next`);
		expect(edit(line, end, { changes: { from: end, to: line.length }, userEvent: 'delete.forward' }).text).toBe(line);
	});

	it('leaves edits by Crate and deletes of whole lines alone', () => {
		expect(edit(line, end, { changes: { from: end, to: line.length } }).text).toBe('- [ ] Buy milk');
		expect(edit(`${line}\nNext`, 0, { changes: { from: 0, to: line.length + 1 }, userEvent: 'delete' }).text).toBe('Next');
	});
});

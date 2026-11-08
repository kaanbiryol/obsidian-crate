import { describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { createReminderLineLeaveExtension, hiddenDescriptionRanges, hiddenReminderMarkerRanges, protectReminderIdMarker, reminderIdChangesForLeftLines } from './editor-line-leave';
import { normalizeReminderIds } from '../core/normalizeReminderIds';

vi.mock('../core/normalizeReminderIds', async importOriginal => {
	const actual = await importOriginal<typeof import('../core/normalizeReminderIds')>();
	return { ...actual, normalizeReminderIds: vi.fn(actual.normalizeReminderIds) };
});

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

	it('reads the note only when the line left is a task without an ID', () => {
		const reminders = Array.from({ length: 5000 }, (_, index) => `- [ ] Task ${index} <!-- crate-id:r${index} -->\n`).join('');
		const text = `${reminders}\nPlain text\n- [ ]\n`;
		vi.mocked(normalizeReminderIds).mockClear();
		for (const line of ['', 'Plain text', '- [ ]']) {
			const from = text.lastIndexOf(`\n${line}\n`) + 1;
			expect(leave(text, from, { selection: { anchor: 0 } })).toEqual(text.split('\n'));
		}
		expect(normalizeReminderIds).not.toHaveBeenCalled();
	});

	it('adds the ID outside undo history, so undo never removes it unseen', async () => {
		const text = '- [ ] Call Sam\nNotes';
		const startState = EditorState.create({ doc: text, selection: EditorSelection.cursor(5), extensions: createReminderLineLeaveExtension(() => true) });
		const transaction = startState.update({ selection: { anchor: text.length } });
		const dispatch = vi.fn<(spec: TransactionSpec) => void>();
		const view = { hasFocus: true, state: transaction.state, dispatch };
		const update = { view, state: transaction.state, startState, changes: transaction.changes, selectionSet: true, focusChanged: false } as unknown as ViewUpdate;
		for (const listener of startState.facet(EditorView.updateListener)) listener(update);
		await Promise.resolve();
		expect(dispatch).toHaveBeenCalledOnce();
		const written = transaction.state.update(dispatch.mock.calls[0]![0]);
		expect(written.state.doc.line(1).text).toMatch(ID);
		expect(written.annotation(Transaction.addToHistory)).toBe(false);
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
		return hiddenReminderMarkerRanges(state, visible).map(({ from, to }) => doc.slice(from, to));
	}

	it('hides every marker with its leading space, including the cursor line', () => {
		expect(hidden(3)).toEqual([' <!-- crate-id:a -->', ' <!-- crate-id:b -->']);
	});

	it('hides a line shared by adjacent visible ranges once', () => {
		expect(hidden(doc.indexOf('Notes'), [{ from: 0, to: 5 }, { from: 5, to: doc.length }])).toEqual([' <!-- crate-id:a -->', ' <!-- crate-id:b -->']);
	});

	it('hides a rule marker together with the ID marker after it', () => {
		const text = '- [ ] Water plants <!-- crate-rule:%7B%22frequency%22%3A%22daily%22%7D --> <!-- crate-id:a -->';
		const state = EditorState.create({ doc: text });
		expect(hiddenReminderMarkerRanges(state, [{ from: 0, to: text.length }]).map(({ from, to }) => text.slice(from, to)))
			.toEqual([' <!-- crate-rule:%7B%22frequency%22%3A%22daily%22%7D --> <!-- crate-id:a -->']);
	});
});

describe('reminder description hiding', () => {
	const hidden = (text: string) => hiddenDescriptionRanges(EditorState.create({ doc: text }).doc).map(({ from, to }) => text.slice(from, to));

	it('hides one-line and multiline descriptions with the line break before them', () => {
		const text = '- [ ] Buy milk <!-- crate-id:a -->\n<!-- crate-desc:Oat milk -->\n- [ ] Call Sam <!-- crate-id:b -->\n<!-- crate-desc:About\nthe trip -->\nNotes';
		expect(hidden(text)).toEqual(['\n<!-- crate-desc:Oat milk -->', '\n<!-- crate-desc:About\nthe trip -->']);
	});

	it('leaves broken and unattached descriptions visible so they can be repaired', () => {
		expect(hidden('- [ ] Buy milk <!-- crate-id:a -->\n<!-- crate-desc:v1:%invalid -->')).toEqual([]);
		expect(hidden('- [ ] Buy milk <!-- crate-id:a -->\n<!-- crate-desc:never closed')).toEqual([]);
		expect(hidden('Notes\n<!-- crate-desc:Oat milk -->')).toEqual([]);
	});
});

describe('reminder ID marker protection', () => {
	const line = '- [ ] Buy milk <!-- crate-id:a -->';
	const end = line.indexOf(' <!--');

	function edit(doc: string, cursor: number, spec: TransactionSpec, anchor = cursor) {
		const state = EditorState.create({ doc, selection: EditorSelection.single(anchor, cursor), extensions: EditorState.transactionFilter.of(protectReminderIdMarker) });
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

	it('keeps the ID on the reminder when pasted lines break it in front of the marker', () => {
		const pasted = edit(line, end, { changes: { from: end, insert: ' and eggs\n- [ ] Bread' }, userEvent: 'input.paste' });
		expect(pasted.text).toBe('- [ ] Buy milk and eggs <!-- crate-id:a -->\n- [ ] Bread');
		expect(pasted.cursor).toBe(pasted.text.length);
		// A line break the editor places after the hidden marker also stays below it.
		expect(edit(line, end, { changes: { from: line.length, insert: '\n- [ ] ' }, userEvent: 'input.type' }).text).toBe(`${line}\n- [ ] `);
	});

	it('deletes the ID with a selection of the whole reminder text, so no hidden marker is left behind', () => {
		const cut = edit(`${line}\nNext`, 0, { changes: { from: 0, to: end }, userEvent: 'delete.cut' }, end);
		expect(cut).toEqual({ text: '\nNext', cursor: 0 });
		expect(edit(line, 6, { changes: { from: 6, to: end }, userEvent: 'delete.selection' }, end).text).toBe('- [ ] ');
		// Erasing one character at a time is an edit of the same reminder.
		const short = '- [ ] a <!-- crate-id:a -->';
		expect(edit(short, 7, { changes: { from: 6, to: 7 }, userEvent: 'delete.backward' }).text).toBe('- [ ]  <!-- crate-id:a -->');
	});

	it('joins the next line instead of deleting the marker alone', () => {
		expect(edit(`${line}\nNext`, end, { changes: { from: end, to: line.length }, userEvent: 'delete.forward' }).text).toBe(`${line}Next`);
		expect(edit(line, end, { changes: { from: end, to: line.length }, userEvent: 'delete.forward' }).text).toBe(line);
	});

	describe('with a description', () => {
		const description = '<!-- crate-desc:Oat milk -->';
		const block = `${line}\n${description}`;

		it('continues Enter after the description so it stays on its reminder', () => {
			const { text, cursor } = edit(block, end, { changes: { from: end, insert: '\n- [ ] ' }, userEvent: 'input' });
			expect(text).toBe(`${block}\n- [ ] `);
			expect(cursor).toBe(text.length);
		});

		it('joins the line after the description to the reminder text on forward delete or backspace', () => {
			const doc = `${block}\nNext`;
			// The editor skips the hidden span, so a forward delete covers the markers and the description.
			expect(edit(doc, end, { changes: { from: end, to: block.length }, userEvent: 'delete.forward' })).toEqual({ text: `- [ ] Buy milkNext <!-- crate-id:a -->\n${description}`, cursor: end });
			expect(edit(doc, block.length + 1, { changes: { from: block.length, to: block.length + 1 }, userEvent: 'delete.backward' }).text).toBe(`- [ ] Buy milkNext <!-- crate-id:a -->\n${description}`);
			expect(edit(block, end, { changes: { from: end, to: block.length }, userEvent: 'delete.forward' }).text).toBe(block);
		});

		it('keeps the cursor in front of the markers when it lands after the description', () => {
			expect(edit(block, 0, { selection: { anchor: block.length } }).cursor).toBe(end);
		});

		it('deletes the description with a selection of the whole reminder text', () => {
			expect(edit(`${block}\nNext`, 0, { changes: { from: 0, to: end }, userEvent: 'delete.cut' }, end).text).toBe('\nNext');
		});
	});

	it('leaves edits by Crate and deletes of whole lines alone', () => {
		expect(edit(line, end, { changes: { from: end, to: line.length } }).text).toBe('- [ ] Buy milk');
		expect(edit(`${line}\nNext`, 0, { changes: { from: 0, to: line.length + 1 }, userEvent: 'delete' }).text).toBe('Next');
	});
});

import { describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { createReminderLineLeaveExtension, createReminderMarkerHiding, hiddenDescriptionRanges, hiddenReminderMarkerRanges, protectReminderIdMarker, reminderClipboard, reminderIdChangesForLeftLines } from './editor-line-leave';
import { normalizeReminderIds } from '../core/normalizeReminderIds';
import { readDescriptionBlock } from '../core/reminderDescription';

vi.mock('../core/normalizeReminderIds', async importOriginal => {
	const actual = await importOriginal<typeof import('../core/normalizeReminderIds')>();
	return { ...actual, normalizeReminderIds: vi.fn(actual.normalizeReminderIds) };
});
vi.mock('../core/reminderDescription', async importOriginal => {
	const actual = await importOriginal<typeof import('../core/reminderDescription')>();
	return { ...actual, readDescriptionBlock: vi.fn(actual.readDescriptionBlock) };
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

	it("adds the ID when Obsidian's Enter rewrites the last character, and undo still removes the typing", async () => {
		const typed = '- [ ] Buy mil';
		const startState = EditorState.create({ doc: typed, selection: EditorSelection.cursor(typed.length), extensions: createReminderLineLeaveExtension(() => true) });
		const typing = startState.update({ changes: { from: typed.length, insert: 'k' }, selection: { anchor: typed.length + 1 }, userEvent: 'input.type' });
		// Smart-list Enter sends no selection: it replaces the character before the cursor with itself, a line break and the list prefix.
		const enter = typing.state.update({ changes: { from: typed.length, to: typed.length + 1, insert: 'k\n- [ ] ' }, userEvent: 'input.type' });
		const dispatch = vi.fn<(spec: TransactionSpec) => void>();
		const view = { hasFocus: true, state: enter.state, dispatch };
		const update = { view, state: enter.state, startState: typing.state, changes: enter.changes, docChanged: true, selectionSet: false, focusChanged: false } as unknown as ViewUpdate;
		vi.mocked(normalizeReminderIds).mockClear();
		for (const listener of startState.facet(EditorView.updateListener)) listener(update);
		await Promise.resolve();
		expect(dispatch).toHaveBeenCalledOnce();
		// Only the line left is rewritten.
		expect(vi.mocked(normalizeReminderIds).mock.calls.map(call => call[3])).toEqual([new Set([0])]);
		const written = enter.state.update(dispatch.mock.calls[0]![0]);
		expect(written.annotation(Transaction.addToHistory)).toBe(false);
		const [left, next] = written.state.doc.toString().split('\n');
		expect(left).toMatch(ID);
		expect(left!.match(ID)![1]).toBe('Buy milk');
		expect(next).toBe('- [ ] ');
		// History maps its inverted steps through changes kept out of it; a whole-line rewrite would swallow the typing's inverse.
		const undo = typing.changes.compose(enter.changes).invert(startState.doc).map(written.changes);
		expect(undo.apply(written.state.doc).toString()).toMatch(/^- \[ \] Buy mil <!-- crate-id:[0-9a-f-]{36} -->$/);
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

	describe('while editing', () => {
		const extensions = createReminderMarkerHiding(() => true, () => undefined);
		const reminder = '- [ ] Buy milk <!-- crate-id:a -->\n<!-- crate-desc:Oat milk -->';
		/** Text under the description decorations, without the shown-text widgets; the marker plugin's decorations need a view. */
		const decorated = (state: EditorState) => state.facet(EditorView.decorations).flatMap(set => {
			if (typeof set === 'function') return [];
			const ranges: string[] = [];
			for (const iter = set.iter(); iter.value; iter.next()) if (iter.from < iter.to) ranges.push(state.doc.sliceString(iter.from, iter.to));
			return ranges;
		});

		it('moves hidden descriptions with edits away from comments without rescanning the note', () => {
			let state = EditorState.create({ doc: `Intro\n- [ ] Call Sam <!-- crate-id:b -->\n\n${reminder}\n\nNotes`, extensions });
			vi.mocked(readDescriptionBlock).mockClear();
			for (const text of ['Intro', 'Call Sam', 'Notes']) {
				const at = state.doc.toString().indexOf(text) + text.length;
				state = state.update({ changes: { from: at, insert: '!' }, userEvent: 'input.type' }).state;
			}
			expect(readDescriptionBlock).not.toHaveBeenCalled();
			expect(decorated(state)).toEqual(['\n<!-- crate-desc:Oat milk -->']);
		});

		it('rescans when an edit can detach or close a description', () => {
			// Removing the checkbox detaches the description under it.
			let state = EditorState.create({ doc: `${reminder}\nNotes`, extensions });
			state = state.update({ changes: { from: 0, to: '- [ ] '.length } }).state;
			expect(decorated(state)).toEqual([]);
			// Closing a multiline description far below its first line hides it.
			const open = '- [ ] Buy milk <!-- crate-id:a -->\n<!-- crate-desc:One\ntwo\nthree\nfour';
			state = EditorState.create({ doc: open, extensions });
			expect(decorated(state)).toEqual([]);
			state = state.update({ changes: { from: open.length, insert: ' -->' }, userEvent: 'input.type' }).state;
			expect(decorated(state)).toEqual(['\n<!-- crate-desc:One\ntwo\nthree\nfour -->']);
		});
	});

	it('hides the comment and shows its decoded text as a block under the reminder', () => {
		const comment = '\n<!-- crate-desc:v1:Oat%20milk%0Afrom%20the%20shop -->';
		const text = `- [ ] Buy milk <!-- crate-id:a -->${comment}\nNotes`, end = text.indexOf('\nNotes');
		const state = EditorState.create({ doc: text, extensions: createReminderMarkerHiding(() => true, () => undefined) });
		const shown: { from: number; to: number; block: unknown; description: unknown }[] = [];
		for (const source of state.facet(EditorView.decorations)) {
			if (typeof source !== 'function') source.between(0, text.length, (from, to, value) => {
				const spec = value.spec as { block?: boolean; widget?: { description?: string } };
				shown.push({ from, to, block: spec.block, description: spec.widget?.description });
			});
		}
		expect(shown).toEqual([
			{ from: end - comment.length, to: end, block: undefined, description: undefined },
			{ from: end, to: end, block: true, description: 'Oat milk\nfrom the shop' },
		]);
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

	/** The selection `cursorCharRight` dispatches after skipping the atomic hidden span. */
	const arrowRight = (head: number) => ({ selection: EditorSelection.cursor(head, -1), scrollIntoView: true, userEvent: 'select' });

	it('moves ArrowRight from the visible end past the marker to the next line', () => {
		expect(edit(`${line}\nNext`, end, arrowRight(line.length)).cursor).toBe(line.length + 1);
		// The last line has no next line, and a click past the marker stays in front of it.
		expect(edit(line, end, arrowRight(line.length)).cursor).toBe(end);
		expect(edit(`${line}\nNext`, end, { selection: EditorSelection.cursor(line.length, -1), userEvent: 'select.pointer' }).cursor).toBe(end);
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

		it('moves ArrowRight from the visible end past the description to the next line', () => {
			expect(edit(`${block}\nNext`, end, arrowRight(line.length)).cursor).toBe(block.length + 1);
			// Without markers, ArrowRight skips the description itself and lands at its end.
			const unmarked = `- [ ] Buy milk\n${description}`;
			expect(edit(`${unmarked}\nNext`, '- [ ] Buy milk'.length, arrowRight(unmarked.length)).cursor).toBe(unmarked.length + 1);
		});

		it('deletes the description with a selection of the whole reminder text', () => {
			expect(edit(`${block}\nNext`, 0, { changes: { from: 0, to: end }, userEvent: 'delete.cut' }, end).text).toBe('\nNext');
			// A selection that already ends after the description deletes as it is.
			expect(edit(`${block}\nNext`, 0, { changes: { from: 0, to: block.length }, userEvent: 'delete.selection' }, block.length).text).toBe('\nNext');
		});

		it('deletes the description with a cut or delete of the whole line', () => {
			const doc = `Before\n${block}\nNext`, from = doc.indexOf(line);
			for (const userEvent of ['delete.cut', 'delete.line']) {
				expect(edit(doc, from + 3, { changes: { from, to: from + line.length + 1 }, userEvent }).text).toBe('Before\nNext');
			}
		});

		it('copies and cuts the whole reminder text with its markers and description', () => {
			const doc = `${block}\nNext`;
			const copied = (anchor: number, head = anchor) => reminderClipboard(EditorState.create({ doc, selection: EditorSelection.single(anchor, head) }));
			expect(copied(0, end)).toEqual({ from: 0, to: end, text: block });
			expect(copied(end, 0)).toEqual({ from: 0, to: end, text: block });
			// With nothing selected, the whole line is copied with its description and line break.
			expect(copied(3)).toEqual({ from: 0, to: line.length + 1, text: `${block}\n` });
			// The title without its checkbox is the whole text; part of it, or a selection that already holds everything, stays a plain copy.
			expect(copied(6, end)?.text).toBe(block.slice(6));
			expect(copied(10, end)).toBeNull();
			expect(copied(0, block.length)).toBeNull();
			const several = EditorState.create({ doc, selection: EditorSelection.create([EditorSelection.range(0, end), EditorSelection.range(doc.length - 2, doc.length)]), extensions: EditorState.allowMultipleSelections.of(true) });
			expect(reminderClipboard(several)).toBeNull();
			// The ID alone travels with a reminder that has no description.
			expect(reminderClipboard(EditorState.create({ doc: line, selection: EditorSelection.single(0, end) }))?.text).toBe(line);
		});

		/** A CodeMirror line move of the cursor line, as Obsidian's move line commands dispatch it. */
		function moveLine(doc: string, cursor: number, forward: boolean) {
			const state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor), extensions: EditorState.transactionFilter.of(protectReminderIdMarker) });
			const current = state.doc.lineAt(cursor), next = state.doc.lineAt(forward ? current.to + 1 : current.from - 1), size = (next.length + 1) * (forward ? 1 : -1);
			const changes = forward
				? [{ from: current.to, to: next.to }, { from: current.from, insert: next.text + '\n' }]
				: [{ from: next.from, to: current.from }, { from: current.to, insert: '\n' + next.text }];
			const moved = state.update({ changes, selection: { anchor: cursor + size }, userEvent: 'move.line' }).state;
			return { text: moved.doc.toString(), line: moved.doc.lineAt(moved.selection.main.head).text };
		}

		it('moves a reminder and its description together', () => {
			const doc = `- [ ] Other\n${block}\nNext`, at = doc.indexOf('Buy');
			expect(moveLine(doc, at, false)).toEqual({ text: `${block}\n- [ ] Other\nNext`, line });
			expect(moveLine(doc, at, true)).toEqual({ text: `- [ ] Other\nNext\n${block}`, line });
		});

		it('moves a line past a reminder and its description', () => {
			const doc = `- [ ] Other\n${block}\nNext`;
			expect(moveLine(doc, doc.length, false)).toEqual({ text: `- [ ] Other\nNext\n${block}`, line: 'Next' });
			expect(moveLine(doc, 3, true)).toEqual({ text: `${block}\n- [ ] Other\nNext`, line: '- [ ] Other' });
		});

		it('keeps a reminder with its description at the end of the note in place', () => {
			const doc = `Before\n${block}`;
			expect(moveLine(doc, doc.indexOf('Buy'), true).text).toBe(doc);
			expect(moveLine('Before\nNext', 9, false).text).toBe('Next\nBefore');
		});

		it('drags a reminder with its markers and description', () => {
			const doc = `${block}\nNext`;
			const state = EditorState.create({ doc, selection: EditorSelection.single(0, end), extensions: EditorState.transactionFilter.of(protectReminderIdMarker) });
			// CodeMirror deletes the dragged selection and inserts its text at the drop.
			const dropped = state.update({ changes: [{ from: 0, to: end }, { from: doc.length, insert: `\n${doc.slice(0, end)}` }], userEvent: 'move.drop' }).state;
			expect(dropped.doc.toString()).toBe(`\nNext\n${block}`);
			expect(dropped.sliceDoc(dropped.selection.main.from, dropped.selection.main.to)).toBe(`\n${block}`);
		});
	});

	it('leaves edits by Crate and deletes of whole lines alone', () => {
		expect(edit(line, end, { changes: { from: end, to: line.length } }).text).toBe('- [ ] Buy milk');
		expect(edit(`${line}\nNext`, 0, { changes: { from: 0, to: line.length + 1 }, userEvent: 'delete' }).text).toBe('Next');
	});
});

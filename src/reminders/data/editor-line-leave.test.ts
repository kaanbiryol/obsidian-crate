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
		const extensions = createReminderMarkerHiding(() => true, () => false);
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
			// Removing the checkbox keeps the description with the reminder's ID; removing the ID detaches it.
			let state = EditorState.create({ doc: `${reminder}\nNotes`, selection: { anchor: reminder.length + 1 }, extensions });
			state = state.update({ changes: { from: 0, to: '- [ ] '.length } }).state;
			expect(decorated(state)).toEqual(['\n<!-- crate-desc:Oat milk -->']);
			const id = state.doc.toString().indexOf(' <!-- crate-id:a -->');
			state = state.update({ changes: { from: id, to: id + ' <!-- crate-id:a -->'.length } }).state;
			expect(decorated(state)).toEqual([]);
			// Closing a multiline description far below its first line hides it.
			const open = 'Notes\n- [ ] Buy milk <!-- crate-id:a -->\n<!-- crate-desc:One\ntwo\nthree\nfour';
			state = EditorState.create({ doc: open, extensions });
			expect(decorated(state)).toEqual([]);
			state = state.update({ changes: { from: open.length, insert: ' -->' }, userEvent: 'input.type' }).state;
			expect(decorated(state)).toEqual(['\n<!-- crate-desc:One\ntwo\nthree\nfour -->']);
		});

		it("shows the description on its reminder's line as its text while a selection is on the reminder or in it", () => {
			const doc = `${reminder}\nNotes`;
			const at = (anchor: number) => decorated(EditorState.create({ doc, selection: { anchor }, extensions }));
			expect(at(doc.length)).toEqual(['\n<!-- crate-desc:Oat milk -->']);
			expect(at(0)).toEqual(['\n<!-- crate-desc:', 'Oat milk', ' -->']);
			expect(at(doc.indexOf('milk -->'))).toEqual(['\n<!-- crate-desc:', 'Oat milk', ' -->']);
			// Line breaks in a longer description show on the same line.
			const longer = '- [ ] Buy milk <!-- crate-id:a -->\n<!-- crate-desc:Oat milk\nfrom the shop -->';
			expect(decorated(EditorState.create({ doc: longer, extensions })))
				.toEqual(['\n<!-- crate-desc:', 'Oat milk\nfrom the shop', '\n', ' -->']);
		});

		it('edits the description text one character at a time', () => {
			const state = EditorState.create({ doc: `${reminder}\nNotes`, selection: { anchor: 0 }, extensions });
			// The marker plugin's ranges need a view; the description's come from the state.
			const view = { state, plugin: () => null } as unknown as EditorView;
			const covered: string[] = [];
			for (const set of state.facet(EditorView.atomicRanges).map(source => source(view))) {
				for (const iter = set.iter(); iter.value; iter.next()) if (iter.from < iter.to) covered.push(state.sliceDoc(iter.from, iter.to));
			}
			expect(covered).not.toContain('Oat milk');
			expect(covered).toContain('\n<!-- crate-desc:');
		});

		it('backspace at the start of a description moves to the title, or removes an empty description', () => {
			const doc = `${reminder}\nNotes`, textFrom = doc.indexOf('Oat');
			const titleEnd = '- [ ] Buy milk'.length;
			let state = EditorState.create({ doc, selection: { anchor: textFrom }, extensions });
			// The editor deletes the hidden parts before the text as one, back to the title's end.
			const back = (from: number) => state.update({ changes: { from, to: state.doc.toString().indexOf('<!-- crate-desc:') + '<!-- crate-desc:'.length }, userEvent: 'delete.backward' }).state;
			const moved = back(titleEnd);
			expect(moved.doc.toString()).toBe(doc);
			expect(moved.selection.main.head).toBe(titleEnd);
			// With the text deleted, the same backspace removes the description.
			state = state.update({ changes: { from: textFrom, to: textFrom + 'Oat milk'.length } }).state;
			const removed = back(titleEnd);
			expect(removed.doc.toString()).toBe('- [ ] Buy milk <!-- crate-id:a -->\nNotes');
			expect(removed.selection.main.head).toBe(titleEnd);
		});

		it("removes a deleted reminder's hidden markers and description instead of joining them to the line above", () => {
			const doc = `Above\n<!-- crate-id:a -->\n<!-- crate-desc:Oat milk -->\nNotes`;
			const state = EditorState.create({ doc, extensions });
			// Backspace at the start of the emptied line, and Delete at the end of the line above.
			for (const userEvent of ['delete.backward', 'delete.forward']) {
				expect(state.update({ changes: { from: 5, to: 6 }, userEvent }).state.doc.toString()).toBe('Above\nNotes');
			}
			// A line with text keeps joining as usual.
			// The cursor lands at the visible end of the line above, in front of its own markers.
			const marked = EditorState.create({ doc: `- [ ] Above <!-- crate-id:z -->\n<!-- crate-id:a -->\nNotes`, extensions });
			const joined = marked.update({ changes: { from: 31, to: 32 }, userEvent: 'delete.backward' }).state;
			expect(joined.doc.toString()).toBe('- [ ] Above <!-- crate-id:z -->\nNotes');
			expect(joined.selection.main.head).toBe('- [ ] Above'.length);
			const text = EditorState.create({ doc: 'Above\n- [ ] Call <!-- crate-id:a -->', extensions });
			expect(text.update({ changes: { from: 5, to: 6 }, userEvent: 'delete.backward' }).state.doc.toString()).toBe('Above- [ ] Call <!-- crate-id:a -->');
		});

		it('keeps an edit from the reminder line into its description from breaking the comment', () => {
			const state = EditorState.create({ doc: `${reminder}\nNotes`, extensions });
			const into = state.doc.toString().indexOf('crate-desc:');
			// Deleting from the title into the middle of the hidden opener deletes only the title's text.
			expect(state.update({ changes: { from: 6, to: into }, userEvent: 'delete.selection' }).state.doc.toString())
				.toBe('- [ ]  <!-- crate-id:a -->\n<!-- crate-desc:Oat milk -->\nNotes');
			// From the description's text past its end deletes the text and what follows, keeping the comment.
			const textFrom = state.doc.toString().indexOf('milk -->');
			expect(state.update({ changes: { from: textFrom, to: state.doc.length - 2 }, userEvent: 'delete.selection' }).state.doc.toString())
				.toBe('- [ ] Buy milk <!-- crate-id:a -->\n<!-- crate-desc:Oat  -->\nes');
			// Deleting the whole reminder with its description is an edit like any other.
			const all = state.update({ changes: { from: 0, to: state.doc.toString().indexOf('\nNotes') }, userEvent: 'delete.selection' }).state;
			expect(all.doc.toString()).toBe('\nNotes');
		});

		it('keeps edits that would break the stored comment out of the description', () => {
			let state = EditorState.create({ doc: `${reminder}\nNotes`, extensions });
			const inside = state.doc.toString().indexOf('milk -->') + 4;
			for (const typed of [' -->', '<!--']) {
				expect(state.update({ changes: { from: inside, insert: typed }, userEvent: 'input.type' }).state.doc).toBe(state.doc);
			}
			// Deleting a comment marker is kept out; other text edits normally.
			const textFrom = state.doc.toString().indexOf('Oat');
			expect(state.update({ changes: { from: textFrom - 1, to: textFrom }, userEvent: 'delete.backward' }).state.doc).toBe(state.doc);
			// Enter at the end of the description starts a new task after it; inside, it breaks the line.
			const textTo = state.doc.toString().indexOf(' -->\nNotes');
			const entered = state.update({ changes: { from: textTo, insert: '\n' }, userEvent: 'input' }).state;
			expect(entered.doc.toString()).toBe(`${reminder}\n- [ ] \nNotes`);
			expect(entered.selection.main.head).toBe(`${reminder}\n- [ ] `.length);
			// The editor's Enter also takes the whitespace after the cursor, the end marker's space.
			const command = state.update({ changes: { from: textTo, to: textTo + 1, insert: '\n' }, userEvent: 'input' }).state;
			expect(command.doc.toString()).toBe(`${reminder}\n- [ ] \nNotes`);
			expect(state.update({ changes: { from: textTo - 4, insert: '\n' }, userEvent: 'input' }).state.doc.toString()).toContain('Oat \nmilk -->');
			// Typing the browser placed after the hidden end marker lands at the end of the text.
			const end = state.doc.toString().indexOf('\nNotes');
			expect(state.update({ changes: { from: end, insert: '!' }, userEvent: 'input.type' }).state.doc.toString()).toContain('Oat milk! -->');
			state = state.update({ changes: { from: inside, insert: ' and\nalmond' }, userEvent: 'input.type' }).state;
			expect(state.doc.toString()).toBe('- [ ] Buy milk <!-- crate-id:a -->\n<!-- crate-desc:Oat milk and\nalmond -->\nNotes');
		});
	});

	it('hides the comment and shows its decoded text as a block under the reminder', () => {
		const comment = '\n<!-- crate-desc:v1:Oat%20milk%0Afrom%20the%20shop -->';
		const text = `- [ ] Buy milk <!-- crate-id:a -->${comment}\nNotes`, end = text.indexOf('\nNotes');
		const state = EditorState.create({ doc: text, extensions: createReminderMarkerHiding(() => true, () => false) });
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

		it('keeps a cursor in the description between its comment markers', () => {
			expect(edit(block, 0, { selection: { anchor: block.length } }).cursor).toBe(block.length - ' -->'.length);
			expect(edit(block, 0, { selection: { anchor: line.length + 3 } }).cursor).toBe(line.length + 1 + '<!-- crate-desc:'.length);
		});

		it('moves ArrowRight from the visible end into the description text', () => {
			const textFrom = line.length + 1 + '<!-- crate-desc:'.length;
			expect(edit(`${block}\nNext`, end, arrowRight(line.length)).cursor).toBe(textFrom);
			// Without markers, ArrowRight lands at the start of the description's line.
			const unmarked = `- [ ] Buy milk\n${description}`;
			expect(edit(`${unmarked}\nNext`, '- [ ] Buy milk'.length, arrowRight('- [ ] Buy milk'.length + 1)).cursor).toBe('- [ ] Buy milk\n<!-- crate-desc:'.length);
			// An encoded description is edited in the reminder editor, so ArrowRight skips it.
			const encoded = `${line}\n<!-- crate-desc:v1:a%20%2D%2D%20b -->`;
			expect(edit(`${encoded}\nNext`, end, arrowRight(line.length)).cursor).toBe(encoded.length + 1);
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

describe('inline descriptions on line leave', () => {
	/** Leaves the reminder on line 1 through the extension, with a view that applies what it dispatches. */
	async function leaveLine(text: string) {
		const startState = EditorState.create({ doc: text, selection: EditorSelection.cursor(5), extensions: createReminderLineLeaveExtension(() => true) });
		const transaction = startState.update({ selection: { anchor: text.length } });
		const dispatched: Transaction[] = [];
		const view = {
			hasFocus: true,
			state: transaction.state,
			dispatch(spec: Transaction | TransactionSpec) {
				const next = spec instanceof Transaction ? spec : view.state.update(spec);
				dispatched.push(next);
				view.state = next.state;
			},
		};
		const update = { view, state: transaction.state, startState, changes: transaction.changes, selectionSet: true, focusChanged: false } as unknown as ViewUpdate;
		for (const listener of startState.facet(EditorView.updateListener)) listener(update);
		await Promise.resolve();
		return { lines: view.state.doc.toString().split('\n'), dispatched };
	}

	it('moves the description under the reminder in undo history, then adds the ID outside it', async () => {
		const { lines, dispatched } = await leaveLine('- [ ] Call Mia // bring receipts\nNext');
		expect(lines[0]!.match(ID)![1]).toBe('Call Mia');
		expect(lines.slice(1)).toEqual(['<!-- crate-desc:bring receipts -->', 'Next']);
		expect(dispatched.map(transaction => transaction.annotation(Transaction.addToHistory))).toEqual([undefined, false]);
		expect(dispatched[0]!.isUserEvent('input.description')).toBe(true);
	});

	it('schedules from the title, not dates in the description', async () => {
		const { lines } = await leaveLine('- [ ] Call Mia tomorrow // ask before friday\nNext');
		expect(lines[0]!.match(ID)![1]).toMatch(/^Call Mia \d{4}-\d{2}-\d{2}$/);
		const tomorrow = new Date();
		tomorrow.setDate(tomorrow.getDate() + 1);
		expect(lines[0]).toContain(`${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`);
		expect(lines[1]).toBe('<!-- crate-desc:ask before friday -->');
	});

	it('keeps an existing ID on its line', async () => {
		const { lines, dispatched } = await leaveLine('- [ ] Call Mia // ask <!-- crate-id:kept -->\nNext');
		expect(lines).toEqual(['- [ ] Call Mia <!-- crate-id:kept -->', '<!-- crate-desc:ask -->', 'Next']);
		expect(dispatched).toHaveLength(1);
	});
});

describe('typing at the end of a saved reminder', () => {
	it('shows a typed space instead of hiding it with the ID marker', () => {
		const doc = '- [ ] Call Mia 2026-11-15 <!-- crate-id:abc -->';
		let state = EditorState.create({ doc, extensions: EditorState.transactionFilter.of(protectReminderIdMarker) });
		state = state.update({ selection: EditorSelection.cursor(doc.length), userEvent: 'select.pointer' }).state;
		for (const typed of [' ', 'a']) {
			const at = state.selection.main.head;
			state = state.update({ changes: { from: at, insert: typed }, selection: { anchor: at + 1 }, userEvent: 'input.type' }).state;
		}
		expect(state.doc.toString()).toBe('- [ ] Call Mia 2026-11-15 a <!-- crate-id:abc -->');
		const hidden = hiddenReminderMarkerRanges(state, [{ from: 0, to: state.doc.length }]);
		expect(hidden.map(({ from, to }) => state.doc.sliceString(from, to))).toEqual([' <!-- crate-id:abc -->']);
	});
});


import { EditorSelection, Transaction, type ChangeSpec, type Line, type SelectionRange, type Text, type TransactionSpec } from '@codemirror/state';
import { TEXT_START, editableDescription, editableDescriptionAt, endMarker, hiddenTail, onlyMarkers, tailEndingAt, wholeReminderEnd } from './reminder-hidden-ranges';

/**
 * Whether a change inside a description's text would break the comment that
 * stores it, such as typing a comment marker or deleting one.
 */
function breaksDescription(transaction: Transaction): boolean {
	const { doc } = transaction.startState;
	let broken = false;
	transaction.changes.iterChangedRanges((fromA, toA) => {
		// An edit may also reach into the comment from the reminder's line above it.
		const before = broken ? null : editableDescriptionAt(doc, fromA) ?? (toA > fromA ? editableDescriptionAt(doc, toA) : null);
		// An edit starting where the comment ends is after it, one ending where it starts is before it,
		// and one covering all of it removes it.
		if (!before || toA > before.to || fromA === before.to || (fromA < before.from && (toA <= before.from || toA === before.to))) return;
		const reminder = transaction.newDoc.lineAt(transaction.changes.mapPos(before.reminder.from));
		const after = editableDescription(transaction.newDoc, reminder);
		broken = !after || after.to !== transaction.changes.mapPos(before.to, -1);
	});
	return broken;
}

/**
 * A deletion that reaches into a shown description's hidden parts, its
 * reminder's markers and comment opener or its comment closer, deletes only
 * what shows; one covering the whole reminder from its text deletes all of it.
 */
function deletingAroundDescription(transaction: Transaction): TransactionSpec | null {
	const { doc } = transaction.startState;
	const changes: { from: number; to: number; text: string }[] = [];
	transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => changes.push({ from, to, text: inserted.toString() }));
	const [change] = changes;
	if (changes.length !== 1 || !change || change.text || change.to <= change.from) return null;
	const description = editableDescriptionAt(doc, change.to - 1) ?? editableDescriptionAt(doc, change.from);
	if (!description) return null;
	const { reminder } = description, textStart = reminder.from + TEXT_START.exec(reminder.text)![0].length;
	if (change.from <= textStart && change.to >= description.to) return null;
	const userEvent = transaction.annotation(Transaction.userEvent);
	// All that shows of the reminder, its title and its description's text, removes all of it, so no hidden part is left behind.
	if (change.from <= textStart && change.to >= description.textTo) {
		return { changes: { from: change.from, to: description.to }, selection: { anchor: change.from }, ...userEvent ? { userEvent } : {} };
	}
	// The comment's closer and the line break after it, which would join the next line onto the comment.
	const closerEnd = Math.min(description.to + 1, doc.length);
	const hidden = [[endMarker(reminder)?.from ?? reminder.to, description.textFrom], [description.textTo, closerEnd]] as const;
	if (!hidden.some(([from, to]) => change.from < to && change.to > from)) return null;
	// A key across the whole hidden end of a reminder shown as a block, which the rules below handle.
	if (change.from <= hidden[0][0] && change.to >= description.to) return null;
	const pieces: { from: number; to: number }[] = [];
	let at = change.from;
	for (const [from, to] of hidden) {
		if (to <= at || from >= change.to) continue;
		if (from > at) pieces.push({ from: at, to: from });
		at = Math.max(at, to);
	}
	if (at < change.to) {
		// A later reminder whose whole text the deletion covers goes with its hidden tail.
		pieces.push({ from: at, to: Math.max(change.to, wholeReminderEnd(doc, at, change.to, true) ?? change.to) });
	}
	// Deleting only hidden parts is a key at their edge, which the rules below handle.
	if (!pieces.length) return null;
	const cursor = Math.min(Math.max(change.from, description.textFrom), description.textTo);
	const specChanges = transaction.startState.changes(pieces);
	const spec: TransactionSpec = { changes: specChanges, selection: { anchor: specChanges.mapPos(change.from < description.textFrom ? (endMarker(reminder)?.from ?? reminder.to) : cursor, -1) }, ...userEvent ? { userEvent } : {} };
	// A deletion across more than one description may still break another; it is kept out.
	return breaksDescription(transaction.startState.update({ ...spec, filter: false })) ? { selection: transaction.startState.selection } : spec;
}

/**
 * Typing that the browser placed on a description's hidden comment markers,
 * moved into its text; Enter at the end of a description, which starts a new
 * task after it as at the end of any reminder; and backspace at the start of
 * its text. Null for any other change.
 */
function typingIntoDescription(transaction: Transaction): TransactionSpec | null {
	const { doc } = transaction.startState;
	let only: { from: number; to: number; text: string } | null = null, count = 0;
	transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => { count++; only = { from, to, text: inserted.toString() }; });
	const change = count === 1 ? only as { from: number; to: number; text: string } | null : null;
	if (!change) return null;
	const userEvent = transaction.annotation(Transaction.userEvent);
	// Backspace at the start of a description's text never deletes what is hidden before it: it removes an
	// empty description, or moves to the end of the title.
	const deleted = !change.text && transaction.isUserEvent('delete.backward') ? editableDescriptionAt(doc, change.to) : null;
	if (deleted && change.to === deleted.textFrom && change.from < deleted.textFrom) {
		const titleEnd = endMarker(deleted.reminder)?.from ?? deleted.reminder.to;
		if (deleted.textFrom === deleted.textTo) return { changes: { from: deleted.reminder.to, to: deleted.to }, selection: { anchor: titleEnd }, ...userEvent ? { userEvent } : {} };
		return { selection: { anchor: titleEnd } };
	}
	const description = change.text ? editableDescriptionAt(doc, change.from) : null;
	if (!description) return null;
	// Enter, which may also take the whitespace after the cursor: here, the space of the hidden end marker.
	if (change.text.startsWith('\n') && !change.text.trim() && change.from >= description.textTo && change.to <= description.to) {
		const task = `\n${/^\s*/.exec(description.reminder.text)![0]}- [ ] `;
		return { changes: { from: description.to, insert: task }, selection: { anchor: description.to + task.length }, ...userEvent ? { userEvent } : {} };
	}
	if (change.from !== change.to || (change.from >= description.textFrom && change.from <= description.textTo)) return null;
	const at = change.from < description.textFrom ? description.textFrom : description.textTo;
	return { changes: { from: at, insert: change.text }, selection: { anchor: at + change.text.length }, ...userEvent ? { userEvent } : {} };
}

/** A reminder line with its description, or any other line on its own. */
const unitEnd = (doc: Text, line: Line) => Math.max(line.to, hiddenTail(doc, line)?.to ?? line.to);
const unitStart = (doc: Text, line: Line) => {
	const tail = tailEndingAt(doc, line.to);
	return tail ? doc.lineAt(tail.from).from : line.from;
};

/**
 * Redoes CodeMirror's line move so a reminder moves with its description and a
 * line moved past a reminder skips its description, or returns null when no
 * description is involved.
 */
function moveLinesWithDescriptions(transaction: Transaction): TransactionSpec | readonly TransactionSpec[] | null {
	const state = transaction.startState, { doc } = state;
	const forward = transaction.newSelection.main.head > state.selection.main.head;
	// CodeMirror's selected line blocks, counting each description as part of its reminder's line.
	const blocks: { from: number; to: number; ranges: SelectionRange[] }[] = [];
	let upto = -1;
	for (const range of state.selection.ranges) {
		const start = doc.lineAt(unitStart(doc, doc.lineAt(range.from)));
		let end = doc.lineAt(range.to);
		if (!range.empty && range.to === end.from) end = doc.lineAt(range.to - 1);
		const to = unitEnd(doc, end), last = blocks[blocks.length - 1];
		if (last && upto >= start.number) { last.to = Math.max(last.to, to); last.ranges.push(range); }
		else blocks.push({ from: start.from, to, ranges: [range] });
		upto = doc.lineAt(to).number + 1;
	}
	const changes: ChangeSpec[] = [], ranges: SelectionRange[] = [];
	for (const block of blocks) {
		if (forward ? block.to === doc.length : block.from === 0) { ranges.push(...block.ranges); continue; }
		const next = doc.lineAt(forward ? block.to + 1 : block.from - 1);
		const from = forward ? next.from : unitStart(doc, next), to = forward ? unitEnd(doc, next) : next.to;
		const text = doc.sliceString(from, to), size = (to - from + 1) * (forward ? 1 : -1);
		if (forward) changes.push({ from: block.to, to }, { from: block.from, insert: text + state.lineBreak });
		else changes.push({ from, to: block.from }, { from: block.to, insert: state.lineBreak + text });
		for (const range of block.ranges) ranges.push(EditorSelection.range(range.anchor + size, range.head + size));
	}
	if (!changes.length) return [];
	const moved = state.changes(changes);
	if (moved.apply(doc).eq(transaction.newDoc)) return null;
	return { changes: moved, selection: EditorSelection.create(ranges, state.selection.mainIndex), scrollIntoView: true, userEvent: 'move.line' };
}

type ChangedRange = { fromA: number; toA: number; text: string };

/** A drag of a reminder's whole text carries its tail to the drop, so it keeps its ID and description. */
function dragWithTail(transaction: Transaction, changes: readonly ChangedRange[], selected: (from: number, to: number) => boolean): TransactionSpec | null {
	const { doc } = transaction.startState;
	const userEvent = transaction.annotation(Transaction.userEvent);
	if (transaction.isUserEvent('move.drop') && changes.length === 2) {
		const removed = changes.find(change => !change.text), dropped = changes.find(change => change.text && change.fromA === change.toA);
		const end = removed && dropped ? wholeReminderEnd(doc, removed.fromA, removed.toA, selected(removed.fromA, removed.toA)) : null;
		if (removed && dropped && end !== null && end > removed.toA && (dropped.fromA < removed.fromA || dropped.fromA > end)) {
			const text = dropped.text + doc.sliceString(removed.toA, end);
			const at = dropped.fromA < removed.fromA ? dropped.fromA : dropped.fromA - (end - removed.fromA);
			return { changes: [{ from: removed.fromA, to: end }, { from: dropped.fromA, insert: text }], selection: { anchor: at, head: at + text.length }, scrollIntoView: true, ...(userEvent ? { userEvent } : {}) };
		}
	}
	return null;
}

/** A single input or delete at a reminder's hidden tail, kept off the tail; null to leave it to the next stage. */
function editAtTail(transaction: Transaction, changes: readonly ChangedRange[], selected: (from: number, to: number) => boolean): Transaction | TransactionSpec | readonly TransactionSpec[] | null {
	const { doc } = transaction.startState;
	const userEvent = transaction.annotation(Transaction.userEvent);
	if (transaction.docChanged && (transaction.isUserEvent('input') || transaction.isUserEvent('delete'))) {
		const [change] = changes;
		const spec = (changes: ChangeSpec, cursor: number): TransactionSpec => ({
			changes, selection: { anchor: cursor }, scrollIntoView: true, ...(userEvent ? { userEvent } : {}),
		});
		// A cut or delete of the whole text or line removes the reminder; a tail left behind would name the next text typed there.
		if (change && changes.length === 1 && !change.text) {
			const end = wholeReminderEnd(doc, change.fromA, change.toA, selected(change.fromA, change.toA));
			if (end !== null) return end === change.toA ? transaction : spec({ from: change.fromA, to: end }, change.fromA);
		}
		// Moves the next line's text up to the reminder's, before its hidden tail, as a join would without the hidden parts.
		// A reminder joined this way merges into this one, so its own hidden tail goes.
		const join = (tail: { from: number; to: number }) => {
			const next = doc.lineAt(tail.to + 1), nextTail = hiddenTail(doc, next);
			const text = nextTail ? doc.sliceString(next.from, nextTail.from) : next.text;
			return spec([{ from: tail.from, insert: text }, { from: tail.to, to: nextTail?.to ?? next.to }], tail.from);
		};
		const line = change && changes.length === 1 ? doc.lineAt(change.fromA) : null;
		const found = line ? hiddenTail(doc, line) : null;
		const tail = found && change!.toA <= found.to ? found : null;
		if (line && tail) {
			const { fromA, toA, text } = change!;
			// Enter or pasted lines at the markers continue after the tail, so the ID and description stay on their reminder.
			const newline = text.indexOf('\n');
			if (newline >= 0 && toA >= tail.from) {
				const from = Math.min(fromA, tail.from), first = text.slice(0, newline), rest = text.slice(newline);
				return spec([{ from, to: tail.from, insert: first }, { from: tail.to, insert: rest }], tail.to + first.length - (tail.from - from) + rest.length);
			}
			if (toA > tail.from) {
				// Edits reaching into the tail stop before it.
				if (fromA < tail.from) return spec({ from: fromA, to: tail.from, insert: text }, fromA + text.length);
				if (text) return spec({ from: tail.from, insert: text }, tail.from + text.length);
				if (tail.to >= doc.length) return [];
				return join(tail);
			}
		}
		// Backspace at the start of the line after a description joins that line to the reminder, not into the description.
		if (change && changes.length === 1 && !change.text && change.toA === change.fromA + 1 && doc.sliceString(change.fromA, change.toA) === '\n') {
			// A line left with only a deleted reminder's hidden markers goes with its description instead of joining.
			const below = doc.lineAt(change.toA);
			if (onlyMarkers(below)) {
				const above = doc.lineAt(change.fromA);
				return spec({ from: change.fromA, to: Math.max(below.to, hiddenTail(doc, below)?.to ?? below.to) }, endMarker(above)?.from ?? change.fromA);
			}
			const aboveLine = doc.lineAt(change.fromA);
			const above = tailEndingAt(doc, change.fromA) ?? (endMarker(aboveLine) ? hiddenTail(doc, aboveLine) : null);
			if (above) return join(above);
		}
	}
	return null;
}

/** Keeps cursors out of hidden tails and inside a shown description's text. */
function clampSelection(transaction: Transaction): Transaction | readonly (Transaction | TransactionSpec)[] {
	const { startState } = transaction;
	if (!transaction.selection) return transaction;
	const next = transaction.state.doc;
	// Keyboard moves, unlike clicks, can start at the visible end.
	const keyboard = !transaction.docChanged && transaction.isUserEvent('select') && !transaction.isUserEvent('select.pointer')
		&& startState.selection.ranges.length === transaction.newSelection.ranges.length;
	let moved = false;
	const ranges = transaction.newSelection.ranges.map((range, index) => {
		const line = next.lineAt(range.head);
		// A cursor in a description's text stays between its comment markers.
		const description = range.empty ? editableDescriptionAt(next, range.head) : null;
		if (description) {
			const head = Math.min(Math.max(range.head, description.textFrom), description.textTo);
			if (head === range.head) return range;
			moved = true;
			return EditorSelection.cursor(head);
		}
		// A click past a hidden description lands at its end, where typing would break it.
		const marker = range.empty ? endMarker(line) ?? (range.head === line.to ? tailEndingAt(next, range.head) : null) : null;
		if (!marker || range.head <= marker.from) return range;
		moved = true;
		// ArrowRight from the visible end skips into the hidden tail; as at any line end, it moves on to the next line.
		const start = keyboard ? startState.selection.ranges[index] : undefined;
		const tail = start?.empty && start.head === marker.from ? hiddenTail(next, next.lineAt(marker.from)) : null;
		// A description shown as text is next; one shown as a block is skipped.
		const editable = tail?.description ? editableDescription(next, next.lineAt(marker.from)) : null;
		if (editable) return EditorSelection.cursor(editable.textFrom);
		return EditorSelection.cursor(tail && tail.to < next.length ? tail.to + 1 : marker.from);
	});
	return moved ? [transaction, { selection: EditorSelection.create(ranges, transaction.newSelection.mainIndex), sequential: true }] : transaction;
}

/**
 * Keeps a reminder's hidden markers at its line end and its description block
 * under it. Typing and deletes at the end of a reminder land before the
 * markers, a line break there continues after the description, and a forward
 * delete of the hidden tail alone joins the next line instead. Cutting,
 * deleting or dragging a selection of the whole text, or the whole line, takes
 * the tail along, and moving lines moves a reminder and its description
 * together. Edits the editor cannot see are healed by `normalizeReminderIds`.
 */
export function protectReminderIdMarker(transaction: Transaction): Transaction | TransactionSpec | readonly (Transaction | TransactionSpec)[] {
	const { startState } = transaction;
	if (transaction.docChanged && transaction.isUserEvent('move.line')) return moveLinesWithDescriptions(transaction) ?? transaction;
	if (transaction.docChanged && (transaction.isUserEvent('input') || transaction.isUserEvent('delete'))) {
		const around = deletingAroundDescription(transaction);
		if (around) return around;
		const inside = typingIntoDescription(transaction);
		// Moved typing must keep the comment readable too, as typing a comment marker would not.
		if (inside) return breaksDescription(startState.update({ ...inside, filter: false })) ? [] : inside;
	}
	// Only the user's own edits are refused. A file reload, a write from another view, undo and redo
	// must apply: Obsidian has already recorded the new text as saved, and dropping it would let
	// this editor save the old text back over it.
	const typed = transaction.isUserEvent('input') || transaction.isUserEvent('delete') || transaction.isUserEvent('move');
	if (transaction.docChanged && typed && breaksDescription(transaction)) return [];
	const changes: { fromA: number; toA: number; text: string }[] = [];
	if (transaction.docChanged) transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => changes.push({ fromA, toA, text: inserted.toString() }));
	const selected = (from: number, to: number) => startState.selection.ranges.some(range => !range.empty && range.from <= from && range.to >= to);
	return dragWithTail(transaction, changes, selected) ?? editAtTail(transaction, changes, selected) ?? clampSelection(transaction);
}

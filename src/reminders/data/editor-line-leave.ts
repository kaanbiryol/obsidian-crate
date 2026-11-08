import { EditorSelection, EditorState, StateField, Transaction, type ChangeSpec, type Line, type Text, type TransactionSpec } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { normalizeReminderIds } from '../core/normalizeReminderIds';
import { readDescriptionBlock } from '../core/reminderDescription';
import { extractReminderId, findReminderIdMarker } from '../core/reminderIdentity';

/** The part of a view update that decides which lines a cursor left. */
interface LineLeave {
	startState: EditorState;
	state: EditorState;
	changes: ViewUpdate['changes'];
	wasFocused: boolean;
	isFocused: boolean;
}

/** A task with text. Only these can gain an ID, so leaving any other line skips reading the whole note. */
const TASK_WITH_TEXT = /^\s*-\s*\[[ xX]\]\s*\S/;

/**
 * Identifies reminder lines the cursor just left, so a new reminder gets its ID
 * when the user moves on instead of after the next save and scan. The scan still
 * owns collision repair and lines edited outside an editor.
 */
export function reminderIdChangesForLeftLines({ startState, state, changes, wasFocused, isFocused }: LineLeave): ChangeSpec[] {
	// Lines left by an unfocused editor were not being typed, so the scan writes them.
	if (!wasFocused) return [];
	const { doc } = state;
	// Map each old cursor's line start: Obsidian's Enter rewrites the line's last character, which would carry the cursor itself along.
	const previous = new Set(startState.selection.ranges.map(range => doc.lineAt(changes.mapPos(startState.doc.lineAt(range.head).from, -1)).number));
	const current = new Set(isFocused ? state.selection.ranges.map(range => doc.lineAt(range.head).number) : []);
	const left = [...previous].filter(line => {
		const { text } = doc.line(line);
		return !current.has(line) && TASK_WITH_TEXT.test(text) && !extractReminderId(text);
	});
	if (!left.length) return [];
	const normalized = normalizeReminderIds(doc.toString(), undefined, undefined, new Set(left.map(number => number - 1))).content.split('\n');
	return left.flatMap(number => {
		const line = doc.line(number), text = normalized[number - 1], before = line.text;
		if (text === undefined || text === before || !extractReminderId(text)) return [];
		// Change only the differing span, so undo history keeps the typing on the line.
		let start = 0, end = 0;
		while (start < before.length && start < text.length && before[start] === text[start]) start++;
		while (end < before.length - start && end < text.length - start && before[before.length - 1 - end] === text[text.length - 1 - end]) end++;
		return [{ from: line.from + start, to: line.to - end, insert: text.slice(start, text.length - end) }];
	});
}

/** Adds reminder IDs as the cursor leaves a line in an editor `canAssign` accepts. */
export function createReminderLineLeaveExtension(canAssign: (state: EditorState) => boolean) {
	return EditorView.updateListener.of(update => {
		// Obsidian's Enter in a list sets no selection, so a document change can leave a line too.
		if (!update.docChanged && !update.selectionSet && !update.focusChanged) return;
		const isFocused = update.view.hasFocus;
		const wasFocused = update.focusChanged ? !isFocused : isFocused;
		if (!canAssign(update.state)) return;
		const changes = reminderIdChangesForLeftLines({ ...update, wasFocused, isFocused });
		if (!changes.length) return;
		// A view cannot dispatch during its own update; skip if the text moved on meanwhile.
		// Undo would remove the hidden ID unseen, and leaving the line again would mint another.
		queueMicrotask(() => {
			if (update.view.state.doc === update.state.doc) update.view.dispatch({ changes, annotations: Transaction.addToHistory.of(false) });
		});
	});
}

const hiddenMarker = Decoration.replace({});

const RULE_MARKERS_REGEX = /<!-- crate-rule:[^>]*? -->/g;
const DESCRIPTION_PREFIX = '<!-- crate-desc:';

/** A line's ID and rule markers, each with its leading whitespace, merged where they touch. */
function lineMarkers(text: string): { from: number; to: number }[] {
	const spans = [...text.matchAll(RULE_MARKERS_REGEX)].map(match => {
		let from = match.index;
		while (from > 0 && /\s/.test(text[from - 1]!)) from--;
		return { from, to: match.index + match[0].length };
	});
	const id = findReminderIdMarker(text);
	if (id) spans.push(id);
	spans.sort((a, b) => a.from - b.from);
	const merged: { from: number; to: number }[] = [];
	for (const span of spans) {
		const last = merged[merged.length - 1];
		if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
		else merged.push({ ...span });
	}
	return merged;
}

/** Markers that end their line, which is the span the editor hides and keeps edits out of. */
function endMarker(line: Line): { from: number; to: number } | null {
	const marker = lineMarkers(line.text).pop();
	return marker && line.from + marker.to === line.to ? { from: line.from + marker.from, to: line.to } : null;
}

/**
 * A valid description block under the reminder on `line`, from that line's end
 * to the block's end. Broken blocks stay visible so they can be repaired.
 */
function descriptionBlock(doc: Text, line: Line): { from: number; to: number } | null {
	if (line.number >= doc.lines || !TASK_WITH_TEXT.test(line.text) || !doc.line(line.number + 1).text.startsWith(DESCRIPTION_PREFIX)) return null;
	const lines = [line.text];
	for (let number = line.number + 1; number <= doc.lines; number++) {
		const { text } = doc.line(number);
		lines.push(text);
		if (text.includes('-->')) break;
	}
	try {
		const { lineCount } = readDescriptionBlock(lines, 0);
		return lineCount ? { from: line.to, to: doc.line(line.number + lineCount).to } : null;
	} catch { return null; }
}

/** The hidden end of a reminder: its end markers and the description block under it. */
function hiddenTail(doc: Text, line: Line): { from: number; to: number; description: boolean } | null {
	const marker = endMarker(line), description = descriptionBlock(doc, line);
	if (!marker && !description) return null;
	return { from: marker?.from ?? line.to, to: description?.to ?? line.to, description: Boolean(description) };
}

/** The tail of the reminder whose description block ends at `position`, a line end. */
function tailEndingAt(doc: Text, position: number): { from: number; to: number; description: boolean } | null {
	if (!doc.lineAt(position).text.endsWith(' -->')) return null;
	// Walk up to the block's first line; only that line may open a comment, and an earlier close ends another block.
	for (let number = doc.lineAt(position).number; number > 1; number--) {
		const { text } = doc.line(number);
		if (text.startsWith(DESCRIPTION_PREFIX)) {
			const tail = hiddenTail(doc, doc.line(number - 1));
			return tail?.description && tail.to === position ? tail : null;
		}
		if (text.includes('<!--') || (number < doc.lineAt(position).number && text.includes('-->'))) return null;
	}
	return null;
}

/** Ranges of reminder ID and rule markers to hide, including the leading space. */
export function hiddenReminderMarkerRanges(state: EditorState, visible: readonly { from: number; to: number }[]): { from: number; to: number }[] {
	const { doc } = state;
	const ranges: { from: number; to: number }[] = [];
	let last = 0;
	for (const { from, to } of visible) {
		// Adjacent visible ranges can share a line.
		for (let number = Math.max(doc.lineAt(from).number, last + 1); number <= doc.lineAt(to).number; number++) {
			last = number;
			const line = doc.line(number);
			for (const marker of lineMarkers(line.text)) ranges.push({ from: line.from + marker.from, to: line.from + marker.to });
		}
	}
	return ranges;
}

/** Ranges of valid description blocks to hide, each from its reminder's line end. */
export function hiddenDescriptionRanges(doc: Text): { from: number; to: number }[] {
	const ranges: { from: number; to: number }[] = [];
	for (let number = 2; number <= doc.lines; number++) {
		if (!doc.line(number).text.startsWith(DESCRIPTION_PREFIX)) continue;
		const block = descriptionBlock(doc, doc.line(number - 1));
		if (!block) continue;
		ranges.push(block);
		number = doc.lineAt(block.to).number;
	}
	return ranges;
}

/** Whether a line holds a comment marker besides its reminder's ID and rule markers. */
function hasCommentMarker(text: string): boolean {
	let rest = text;
	for (const { from, to } of lineMarkers(text).reverse()) rest = rest.slice(0, from) + rest.slice(to);
	return rest.includes('<!--') || rest.includes('-->');
}

/**
 * Whether a change can open, close or detach a description block. Blocks start
 * and end at comment markers and attach to the line above, so only a changed
 * line holding a marker, or next to one, can.
 */
function touchesDescriptions(transaction: Transaction): boolean {
	const near = (doc: Text, from: number, to: number) => {
		for (let number = Math.max(1, doc.lineAt(from).number - 1), last = Math.min(doc.lines, doc.lineAt(to).number + 1); number <= last; number++) {
			if (hasCommentMarker(doc.line(number).text)) return true;
		}
		return false;
	};
	let touched = false;
	transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
		touched ||= near(transaction.startState.doc, fromA, toA) || near(transaction.state.doc, fromB, toB);
	});
	return touched;
}

/** Where a line's text starts, after its indentation and any task checkbox. */
const TEXT_START = /^\s*(?:-\s*\[[ xX]\]\s*)?/;

/**
 * Keeps a reminder's hidden markers at its line end and its description block
 * under it. Typing and deletes at the end of a reminder land before the
 * markers, a line break there continues after the description, and a forward
 * delete of the hidden tail alone joins the next line instead. Deleting a
 * selection of the whole text deletes the tail too. Edits the editor cannot see
 * are healed by `normalizeReminderIds`.
 */
export function protectReminderIdMarker(transaction: Transaction): Transaction | TransactionSpec | readonly (Transaction | TransactionSpec)[] {
	const { startState } = transaction;
	const { doc } = startState;
	if (transaction.docChanged && (transaction.isUserEvent('input') || transaction.isUserEvent('delete'))) {
		const changes: { fromA: number; toA: number; text: string }[] = [];
		transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => changes.push({ fromA, toA, text: inserted.toString() }));
		const [change] = changes;
		const userEvent = transaction.annotation(Transaction.userEvent);
		const spec = (changes: ChangeSpec, cursor: number): TransactionSpec => ({
			changes, selection: { anchor: cursor }, scrollIntoView: true, ...(userEvent ? { userEvent } : {}),
		});
		// Moves the line after a description up to its reminder's text, as a join would without the hidden lines between.
		const join = (tail: { from: number; to: number }) => {
			const next = doc.lineAt(tail.to + 1);
			return spec([{ from: tail.from, insert: next.text }, { from: tail.to, to: next.to }], tail.from);
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
			// A cut or delete of the whole text removes the reminder; a tail left behind would name the next text typed there.
			if (!text && toA >= tail.from && fromA <= line.from + TEXT_START.exec(line.text)![0].length
				&& startState.selection.ranges.some(range => !range.empty && range.from <= fromA && range.to >= toA)) return spec({ from: fromA, to: tail.to }, fromA);
			if (toA > tail.from) {
				// Edits reaching into the tail stop before it.
				if (fromA < tail.from) return spec({ from: fromA, to: tail.from, insert: text }, fromA + text.length);
				if (text) return spec({ from: tail.from, insert: text }, tail.from + text.length);
				if (tail.to >= doc.length) return [];
				return tail.description ? join(tail) : spec({ from: tail.to, to: tail.to + 1 }, tail.from);
			}
		}
		// Backspace at the start of the line after a description joins that line to the reminder, not into the description.
		if (change && changes.length === 1 && !change.text && change.toA === change.fromA + 1 && doc.sliceString(change.fromA, change.toA) === '\n') {
			const above = tailEndingAt(doc, change.fromA);
			if (above) return join(above);
		}
	}
	if (!transaction.selection) return transaction;
	const next = transaction.state.doc;
	// Keyboard moves, unlike clicks, can start at the visible end.
	const keyboard = !transaction.docChanged && transaction.isUserEvent('select') && !transaction.isUserEvent('select.pointer')
		&& startState.selection.ranges.length === transaction.newSelection.ranges.length;
	let moved = false;
	const ranges = transaction.newSelection.ranges.map((range, index) => {
		const line = next.lineAt(range.head);
		// A click past a hidden description lands at its end, where typing would break it.
		const marker = range.empty ? endMarker(line) ?? (range.head === line.to ? tailEndingAt(next, range.head) : null) : null;
		if (!marker || range.head <= marker.from) return range;
		moved = true;
		// ArrowRight from the visible end skips into the hidden tail; as at any line end, it moves on to the next line.
		const start = keyboard ? startState.selection.ranges[index] : undefined;
		const tail = start?.empty && start.head === marker.from ? hiddenTail(next, next.lineAt(marker.from)) : null;
		return EditorSelection.cursor(tail && tail.to < next.length ? tail.to + 1 : marker.from);
	});
	return moved ? [transaction, { selection: EditorSelection.create(ranges, transaction.newSelection.mainIndex), sequential: true }] : transaction;
}

/**
 * Hides reminder ID and rule markers and description blocks in editors
 * `isReminderEditor` accepts, and keeps the cursor in front of them.
 */
export function createReminderMarkerHiding(isReminderEditor: (state: EditorState) => boolean) {
	const decorate = (view: EditorView): DecorationSet => isReminderEditor(view.state)
		? Decoration.set(hiddenReminderMarkerRanges(view.state, view.visibleRanges).map(({ from, to }) => hiddenMarker.range(from, to)))
		: Decoration.none;
	const hiding = ViewPlugin.define(view => ({
		decorations: decorate(view),
		update(update: ViewUpdate) {
			if (update.docChanged || update.viewportChanged) this.decorations = decorate(update.view);
		},
	}), { decorations: plugin => plugin.decorations });
	// Replacing line breaks changes line layout, which only a state field may do.
	const decorateDescriptions = (state: EditorState): DecorationSet => isReminderEditor(state)
		? Decoration.set(hiddenDescriptionRanges(state.doc).map(({ from, to }) => hiddenMarker.range(from, to)))
		: Decoration.none;
	const descriptions = StateField.define<DecorationSet>({
		create: decorateDescriptions,
		// Rescanning the note on every keystroke is slow in long notes; other edits only move the blocks.
		update: (value, transaction) => !transaction.docChanged ? value
			: touchesDescriptions(transaction) ? decorateDescriptions(transaction.state) : value.map(transaction.changes),
		provide: field => EditorView.decorations.from(field),
	});
	return [
		hiding,
		descriptions,
		EditorView.atomicRanges.of(view => view.plugin(hiding)?.decorations ?? Decoration.none),
		EditorView.atomicRanges.of(view => view.state.field(descriptions, false) ?? Decoration.none),
		EditorState.transactionFilter.of(transaction => isReminderEditor(transaction.startState) ? protectReminderIdMarker(transaction) : transaction),
	];
}

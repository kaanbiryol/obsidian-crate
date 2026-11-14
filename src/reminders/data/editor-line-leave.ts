import { EditorSelection, EditorState, StateField, Transaction, type ChangeSpec, type Line, type SelectionRange, type Text, type TransactionSpec } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { normalizeReminderIds } from '../core/normalizeReminderIds';
import { normalizeReminderScheduleLine } from '../core/normalizeReminderSchedule';
import { readDescriptionBlock } from '../core/reminderDescription';
import { extractReminderId, findReminderIdMarker } from '../core/reminderIdentity';
import { DescriptionBreakWidget, DescriptionMarkerWidget } from './description-widgets';
import { inlineDescriptionChanges } from './inline-description';

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

/** Task lines with text that the cursor just left. */
function leftTaskLines({ startState, state, changes, wasFocused, isFocused }: LineLeave): number[] {
	// Lines left by an unfocused editor were not being typed, so the scan writes them.
	if (!wasFocused) return [];
	const { doc } = state;
	// Map each old cursor's line start: Obsidian's Enter rewrites the line's last character, which would carry the cursor itself along.
	const previous = new Set(startState.selection.ranges.map(range => doc.lineAt(changes.mapPos(startState.doc.lineAt(range.head).from, -1)).number));
	const current = new Set(isFocused ? state.selection.ranges.map(range => doc.lineAt(range.head).number) : []);
	return [...previous].filter(line => !current.has(line) && TASK_WITH_TEXT.test(doc.line(line).text));
}

/** The change that replaces a line's text with `text`, touching only the span that differs. */
function lineChange(line: Line, text: string): ChangeSpec {
	const before = line.text;
	let start = 0, end = 0;
	while (start < before.length && start < text.length && before[start] === text[start]) start++;
	while (end < before.length - start && end < text.length - start && before[before.length - 1 - end] === text[text.length - 1 - end]) end++;
	return { from: line.from + start, to: line.to - end, insert: text.slice(start, text.length - end) };
}

/** Typed dates saved on the new reminder lines among `lineNumbers`; lines with an ID are saved by the scan. */
function scheduleChanges(doc: Text, lineNumbers: readonly number[]): ChangeSpec[] {
	return lineNumbers.flatMap(number => {
		const line = doc.line(number);
		if (extractReminderId(line.text)) return [];
		let saved: string;
		try { saved = normalizeReminderScheduleLine(line.text); } catch { return []; }
		return saved === line.text ? [] : [lineChange(line, saved)];
	});
}

/** IDs for the reminder lines among `lineNumbers` that have none. */
function reminderIdChanges(doc: Text, lineNumbers: readonly number[]): ChangeSpec[] {
	const left = lineNumbers.filter(number => !extractReminderId(doc.line(number).text));
	if (!left.length) return [];
	const normalized = normalizeReminderIds(doc.toString(), undefined, undefined, new Set(left.map(number => number - 1))).content.split('\n');
	return left.flatMap(number => {
		const line = doc.line(number), text = normalized[number - 1];
		// Change only the differing span, so undo history keeps the typing on the line.
		return text === undefined || text === line.text || !extractReminderId(text) ? [] : [lineChange(line, text)];
	});
}

/**
 * Identifies reminder lines the cursor just left, so a new reminder gets its ID
 * when the user moves on instead of after the next save and scan. The scan still
 * owns collision repair and lines edited outside an editor.
 */
export function reminderIdChangesForLeftLines(leave: LineLeave): ChangeSpec[] {
	return reminderIdChanges(leave.state.doc, leftTaskLines(leave));
}

/**
 * As the cursor leaves a line in an editor `canAssign` accepts, moves a
 * description typed after ` // ` under the reminder, then adds the reminder's ID.
 */
export function createReminderLineLeaveExtension(canAssign: (state: EditorState) => boolean) {
	return EditorView.updateListener.of(update => {
		// Obsidian's Enter in a list sets no selection, so a document change can leave a line too.
		if (!update.docChanged && !update.selectionSet && !update.focusChanged) return;
		const isFocused = update.view.hasFocus;
		const wasFocused = update.focusChanged ? !isFocused : isFocused;
		if (!canAssign(update.state)) return;
		const left = leftTaskLines({ ...update, wasFocused, isFocused });
		if (!left.length) return;
		const { view } = update, descriptions = inlineDescriptionChanges(update.state.doc, left);
		const dates = descriptions.length ? null : scheduleChanges(update.state.doc, left);
		// Without a description or date to save the IDs are known now; otherwise they follow the edited lines.
		const known = descriptions.length || dates?.length ? null : reminderIdChanges(update.state.doc, left);
		if (known && !known.length) return;
		// A view cannot dispatch during its own update; skip if the text moved on meanwhile.
		queueMicrotask(() => {
			if (view.state.doc !== update.state.doc) return;
			let lines = left;
			// Undo brings back what each step replaced, so it never leaves half of it.
			const apply = (spec: TransactionSpec) => {
				const before = view.state.doc, transaction = view.state.update(spec);
				view.dispatch(transaction);
				lines = lines.map(number => view.state.doc.lineAt(transaction.changes.mapPos(before.line(number).from, -1)).number);
			};
			// Filters would keep the block from landing after the line's hidden markers.
			if (descriptions.length) apply({ changes: descriptions, userEvent: 'input.description', filter: false });
			const saved = dates ?? scheduleChanges(view.state.doc, lines);
			if (saved.length) apply({ changes: saved, userEvent: 'input.date', filter: false });
			// Undo would remove the hidden ID unseen, and leaving the line again would mint another.
			const ids = known ?? reminderIdChanges(view.state.doc, lines);
			if (ids.length) view.dispatch({ changes: ids, annotations: Transaction.addToHistory.of(false) });
		});
	});
}

const hiddenMarker = Decoration.replace({});
const descriptionMarker = Decoration.replace({ widget: new DescriptionMarkerWidget() });
const descriptionBreak = Decoration.replace({ widget: new DescriptionBreakWidget() });
const descriptionText = Decoration.mark({ class: 'crate-reminder-description-source' });

/** Revealed reminder line starts, moved through a change. */
const mapRevealed = (revealed: string, transaction: Transaction) =>
	revealed ? revealed.split(',').map(from => transaction.changes.mapPos(Number(from))).sort((a, b) => a - b).join() : '';

const RULE_MARKERS_REGEX = /<!-- crate-rule:[^>]*? -->/g;
const DESCRIPTION_PREFIX = '<!-- crate-desc:';

/**
 * A line's ID and rule markers, each with the one space it is written after,
 * merged where they touch. Other spaces before a marker stay visible, so a space
 * typed at the end of a reminder shows.
 */
function lineMarkers(text: string): { from: number; to: number }[] {
	const withSpace = (start: number, to: number) => ({ from: start > 0 && /\s/.test(text[start - 1]!) ? start - 1 : start, to });
	const spans = [...text.matchAll(RULE_MARKERS_REGEX)].map(match => withSpace(match.index, match.index + match[0].length));
	const id = findReminderIdMarker(text);
	if (id) spans.push(withSpace(text.indexOf('<!--', id.from), id.to));
	spans.sort((a, b) => a.from - b.from);
	const merged: { from: number; to: number }[] = [];
	for (const span of spans) {
		const last = merged[merged.length - 1];
		if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
		else merged.push({ ...span });
	}
	return merged;
}

/** Whether a line holds nothing but a reminder's hidden markers, as when its text and checkbox were deleted. */
function onlyMarkers(line: Line): boolean {
	const markers = lineMarkers(line.text);
	if (!markers.length) return false;
	let rest = line.text;
	for (const { from, to } of [...markers].reverse()) rest = rest.slice(0, from) + rest.slice(to);
	return !rest.trim();
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
function descriptionBlock(doc: Text, line: Line): { from: number; to: number; description?: string } | null {
	// A reminder whose checkbox is being edited away keeps its ID, and its description stays hidden with it.
	const owner = TASK_WITH_TEXT.test(line.text) || findReminderIdMarker(line.text) !== null;
	if (line.number >= doc.lines || !owner || !doc.line(line.number + 1).text.startsWith(DESCRIPTION_PREFIX)) return null;
	const lines = [line.text];
	for (let number = line.number + 1; number <= doc.lines; number++) {
		const { text } = doc.line(number);
		lines.push(text);
		if (text.includes('-->')) break;
	}
	try {
		const { description, lineCount } = readDescriptionBlock(lines, 0);
		return lineCount ? { from: line.to, to: doc.line(line.number + lineCount).to, description } : null;
	} catch { return null; }
}

/** The hidden end of a reminder: its end markers and the description block under it. */
function hiddenTail(doc: Text, line: Line): { from: number; to: number; description: boolean } | null {
	const marker = endMarker(line), description = descriptionBlock(doc, line);
	if (!marker && !description) return null;
	return { from: marker?.from ?? line.to, to: description?.to ?? line.to, description: Boolean(description) };
}

const DESCRIPTION_SUFFIX = ' -->';

/**
 * A description block stored as literal text, which the editor can show as text
 * to edit, with the text between its comment markers. Encoded blocks are edited
 * in the reminder editor.
 */
interface EditableDescription {
	reminder: Line;
	from: number;
	to: number;
	textFrom: number;
	textTo: number;
}

function editableDescription(doc: Text, reminder: Line): EditableDescription | null {
	const block = descriptionBlock(doc, reminder);
	if (!block) return null;
	const first = doc.line(reminder.number + 1);
	if (/^v\d+:/.test(first.text.slice(DESCRIPTION_PREFIX.length).trimStart())) return null;
	return { reminder, from: first.from, to: block.to, textFrom: first.from + DESCRIPTION_PREFIX.length, textTo: block.to - DESCRIPTION_SUFFIX.length };
}

/** The editable description whose comment lines hold `position`. */
function editableDescriptionAt(doc: Text, position: number): EditableDescription | null {
	const at = doc.lineAt(position).number;
	// Only a block's first line opens its comment; an earlier close ends another block.
	for (let number = at; number > 1 && number > at - 200; number--) {
		const { text } = doc.line(number);
		if (number < at && text.includes('-->')) return null;
		if (text.startsWith(DESCRIPTION_PREFIX)) {
			const description = editableDescription(doc, doc.line(number - 1));
			return description && position <= description.to ? description : null;
		}
		if (text.includes('<!--')) return null;
	}
	return null;
}

/** The reminders whose descriptions show as text: those a selection starts or ends on, or in. */
function revealedDescriptions(doc: Text, selection: EditorSelection): Set<number> {
	const revealed = new Set<number>();
	for (const range of selection.ranges) {
		for (const position of [range.anchor, range.head]) {
			const line = doc.lineAt(position);
			const description = editableDescriptionAt(doc, position) ?? editableDescription(doc, line);
			if (description) revealed.add(description.reminder.from);
		}
	}
	return revealed;
}

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
	if (at < change.to) pieces.push({ from: at, to: change.to });
	// Deleting only hidden parts is a key at their edge, which the rules below handle.
	if (!pieces.length) return null;
	const userEvent = transaction.annotation(Transaction.userEvent);
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

/** Where a line's text starts, after its indentation and any task checkbox. */
const TEXT_START = /^\s*(?:-\s*\[[ xX]\]\s*)?/;

/** The hidden tail that `position` touches, from its start to its end inclusive. */
function tailAround(doc: Text, position: number): { from: number; to: number; description: boolean } | null {
	const line = doc.lineAt(position);
	// A whole-line range ends at the start of its reminder's description.
	const above = line.number > 1 && line.text.startsWith(DESCRIPTION_PREFIX) ? hiddenTail(doc, doc.line(line.number - 1)) : null;
	const tail = above ?? hiddenTail(doc, line) ?? tailEndingAt(doc, position);
	return tail && tail.from <= position && position <= tail.to ? tail : null;
}

/**
 * Where a copy, cut, delete or drag of `from`..`to` should end so a reminder
 * whose whole text it covers keeps its hidden markers and description, or null
 * when it covers no whole reminder. Ranges that took the reminder's line break
 * also take the one after its description. Only selections and whole lines
 * count: deleting the last character of a short title edits it in place.
 */
function wholeReminderEnd(doc: Text, from: number, to: number, selected: boolean): number | null {
	const tail = tailAround(doc, to);
	if (!tail) return null;
	const line = doc.lineAt(tail.from), wholeLine = to > line.to;
	if (!(selected || wholeLine) || from > line.from + TEXT_START.exec(line.text)![0].length) return null;
	if (to >= tail.to) return to;
	return wholeLine ? Math.min(tail.to + 1, doc.length) : tail.to;
}

/**
 * The range CodeMirror copies or cuts for a single selection, and the text to
 * copy when that range should carry a reminder's hidden tail, or null to leave
 * the copy to CodeMirror. The cut itself is extended by `protectReminderIdMarker`.
 */
export function reminderClipboard(state: EditorState): { from: number; to: number; text: string } | null {
	if (state.selection.ranges.length > 1) return null;
	const { main } = state.selection, line = state.doc.lineAt(main.head);
	// With nothing selected, CodeMirror copies and cuts the whole line.
	const from = main.empty ? line.from : main.from, to = main.empty ? Math.min(line.to + 1, state.doc.length) : main.to;
	const end = wholeReminderEnd(state.doc, from, to, true);
	return end === null || end === to ? null : { from, to, text: state.sliceDoc(from, end) };
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

/** Valid description blocks to hide, each from its reminder's line end, with the text they hold. */
export function hiddenDescriptionRanges(doc: Text): { from: number; to: number; description?: string }[] {
	const ranges: { from: number; to: number; description?: string }[] = [];
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
	const { doc } = startState;
	if (transaction.docChanged && transaction.isUserEvent('move.line')) return moveLinesWithDescriptions(transaction) ?? transaction;
	if (transaction.docChanged && (transaction.isUserEvent('input') || transaction.isUserEvent('delete'))) {
		const around = deletingAroundDescription(transaction);
		if (around) return around;
		const inside = typingIntoDescription(transaction);
		// Moved typing must keep the comment readable too, as typing a comment marker would not.
		if (inside) return breaksDescription(startState.update({ ...inside, filter: false })) ? [] : inside;
	}
	if (transaction.docChanged && breaksDescription(transaction)) return [];
	const changes: { fromA: number; toA: number; text: string }[] = [];
	if (transaction.docChanged) transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => changes.push({ fromA, toA, text: inserted.toString() }));
	const selected = (from: number, to: number) => startState.selection.ranges.some(range => !range.empty && range.from <= from && range.to >= to);
	const userEvent = transaction.annotation(Transaction.userEvent);
	// A drag of a reminder's whole text carries its tail to the drop, so it keeps its ID and description.
	if (transaction.isUserEvent('move.drop') && changes.length === 2) {
		const removed = changes.find(change => !change.text), dropped = changes.find(change => change.text && change.fromA === change.toA);
		const end = removed && dropped ? wholeReminderEnd(doc, removed.fromA, removed.toA, selected(removed.fromA, removed.toA)) : null;
		if (removed && dropped && end !== null && end > removed.toA && (dropped.fromA < removed.fromA || dropped.fromA > end)) {
			const text = dropped.text + doc.sliceString(removed.toA, end);
			const at = dropped.fromA < removed.fromA ? dropped.fromA : dropped.fromA - (end - removed.fromA);
			return { changes: [{ from: removed.fromA, to: end }, { from: dropped.fromA, insert: text }], selection: { anchor: at, head: at + text.length }, scrollIntoView: true, ...(userEvent ? { userEvent } : {}) };
		}
	}
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
			// A line left with only a deleted reminder's hidden markers goes with its description instead of joining.
			const below = doc.lineAt(change.toA);
			if (onlyMarkers(below)) {
				const above = doc.lineAt(change.fromA);
				return spec({ from: change.fromA, to: Math.max(below.to, hiddenTail(doc, below)?.to ?? below.to) }, endMarker(above)?.from ?? change.fromA);
			}
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

/** The first line of the reminder whose description ends where a description widget sits. */
function describedReminder(view: EditorView, element: HTMLElement): Line | null {
	const tail = tailEndingAt(view.state.doc, view.posAtDOM(element));
	return tail ? view.state.doc.lineAt(tail.from) : null;
}

/**
 * A reminder's description, shown as text under its title while the comment
 * that stores it stays hidden. Selecting it opens the reminder for editing, or,
 * before the reminder is indexed, puts the cursor at the end of its text.
 */
class DescriptionWidget extends WidgetType {
	constructor(readonly description: string, readonly open: (reminderId: string) => boolean) { super(); }

	eq(other: DescriptionWidget) { return other.description === this.description; }

	toDOM(view: EditorView) {
		const element = createDiv({ cls: 'crate-reminder-description' });
		element.createDiv({ cls: 'crate-reminder-description__text', text: this.description, attr: { role: 'button' } }).addEventListener('click', event => {
			event.preventDefault();
			const reminder = describedReminder(view, element), id = reminder && extractReminderId(reminder.text);
			if (!reminder || (id && this.open(id))) return;
			const description = editableDescription(view.state.doc, reminder);
			if (!description) return;
			view.focus();
			view.dispatch({ selection: { anchor: description.textTo } });
		});
		return element;
	}
}

/** Lines each description up with its reminder's text, which the editor indents line by line. */
const alignDescriptions = ViewPlugin.define(view => {
	const measure = () => view.requestMeasure({
		key: alignDescriptions,
		read: () => [...view.contentDOM.querySelectorAll<HTMLElement>('.crate-reminder-description')].map(element => {
			const reminder = describedReminder(view, element);
			const start = reminder && view.coordsAtPos(reminder.from + TEXT_START.exec(reminder.text)![0].length, 1);
			return { element, indent: start ? Math.max(0, Math.round(start.left - element.getBoundingClientRect().left)) : null };
		}),
		write: indents => {
			for (const { element, indent } of indents) if (indent !== null) element.setCssProps({ '--crate-reminder-description-indent': `${indent}px` });
		},
	});
	measure();
	return { update: (update: ViewUpdate) => { if (update.docChanged || update.geometryChanged || update.viewportChanged) measure(); } };
});

/**
 * Hides reminder ID and rule markers in editors `isReminderEditor` accepts and
 * shows description blocks as text, keeps the cursor in front of them, and
 * copies a reminder's whole text with what is hidden.
 */
export function createReminderMarkerHiding(isReminderEditor: (state: EditorState) => boolean, openReminder: (reminderId: string) => boolean) {
	const decorate = (view: EditorView): DecorationSet => isReminderEditor(view.state)
		? Decoration.set(hiddenReminderMarkerRanges(view.state, view.visibleRanges).map(({ from, to }) => hiddenMarker.range(from, to)))
		: Decoration.none;
	const hiding = ViewPlugin.define(view => ({
		decorations: decorate(view),
		update(update: ViewUpdate) {
			if (update.docChanged || update.viewportChanged) this.decorations = decorate(update.view);
		},
	}), { decorations: plugin => plugin.decorations });
	// Replacing line breaks and adding block widgets change line layout, which only a state
	// field may do. As a block below the title, the text is skipped by moving up and down.
	// While a selection is on a reminder or in its description, the description shows on the reminder's line as its text to edit.
	// Built from a transaction's new text and selection: a field may not read the state it is part of.
	const decorateDescriptions = (enabled: boolean, doc: Text, selection: EditorSelection): { decorations: DecorationSet; revealed: string } => {
		if (!enabled) return { decorations: Decoration.none, revealed: '' };
		const revealed = revealedDescriptions(doc, selection);
		const decorations = Decoration.set(hiddenDescriptionRanges(doc).flatMap(({ from, to, description }) => {
			const editable = revealed.has(doc.lineAt(from).from) ? editableDescription(doc, doc.lineAt(from)) : null;
			if (editable) {
				// On the reminder's line after its bar, as it was typed there, with its line breaks marked.
				const breaks: number[] = [];
				for (let number = doc.lineAt(editable.from).number; number < doc.lineAt(editable.to).number; number++) breaks.push(doc.line(number).to);
				return [
					descriptionMarker.range(from, editable.textFrom),
					...editable.textFrom < editable.textTo ? [descriptionText.range(editable.textFrom, editable.textTo)] : [],
					...breaks.map(position => descriptionBreak.range(position, position + 1)),
					hiddenMarker.range(editable.textTo, editable.to),
				];
			}
			return [
				hiddenMarker.range(from, to),
				...description ? [Decoration.widget({ widget: new DescriptionWidget(description, openReminder), block: true, side: 1 }).range(to)] : [],
			];
		}), true);
		return { decorations, revealed: [...revealed].sort((a, b) => a - b).join() };
	};
	const descriptions = StateField.define<{ decorations: DecorationSet; revealed: string }>({
		create: state => decorateDescriptions(isReminderEditor(state), state.doc, state.selection),
		// Rescanning the note on every keystroke is slow in long notes; other edits only move the blocks.
		update: (value, transaction) => {
			const { newDoc, newSelection } = transaction;
			const redecorate = () => decorateDescriptions(isReminderEditor(transaction.startState), newDoc, newSelection);
			if (transaction.docChanged && touchesDescriptions(transaction)) return redecorate();
			const revealed = transaction.selection || transaction.docChanged ? [...revealedDescriptions(newDoc, newSelection)].sort((a, b) => a - b).join() : value.revealed;
			if (revealed !== (transaction.docChanged ? mapRevealed(value.revealed, transaction) : value.revealed)) return redecorate();
			return transaction.docChanged ? { decorations: value.decorations.map(transaction.changes), revealed } : value;
		},
		provide: field => EditorView.decorations.from(field, value => value.decorations),
	});
	// CodeMirror copies only the selected text; a reminder's whole text also takes what is hidden.
	const copy = (event: ClipboardEvent, view: EditorView) => {
		const copied = view.hasFocus && event.clipboardData && isReminderEditor(view.state) ? reminderClipboard(view.state) : null;
		if (!copied) return false;
		if (event.type === 'cut' && !view.state.readOnly) {
			view.dispatch({ changes: { from: copied.from, to: copied.to }, scrollIntoView: true, userEvent: 'delete.cut' });
		}
		event.clipboardData!.clearData();
		event.clipboardData!.setData('text/plain', copied.text);
		return true;
	};
	return [
		hiding,
		descriptions,
		alignDescriptions,
		EditorView.atomicRanges.of(view => view.plugin(hiding)?.decorations ?? Decoration.none),
		// Hidden text moves and deletes as one; the description's own text edits normally.
		EditorView.atomicRanges.of(view => {
			const decorations = view.state.field(descriptions, false)?.decorations;
			return decorations ? decorations.update({ filter: (_from, _to, value) => value !== descriptionText }) : Decoration.none;
		}),
		EditorView.domEventHandlers({ copy, cut: copy }),
		EditorState.transactionFilter.of(transaction => isReminderEditor(transaction.startState) ? protectReminderIdMarker(transaction) : transaction),
	];
}

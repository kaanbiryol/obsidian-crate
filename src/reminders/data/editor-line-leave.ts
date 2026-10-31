import { EditorSelection, EditorState, Transaction, type ChangeSpec, type Line, type TransactionSpec } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { normalizeReminderIds } from '../core/normalizeReminderIds';
import { extractReminderId, findReminderIdMarker } from '../core/reminderIdentity';

/** The part of a view update that decides which lines a cursor left. */
interface LineLeave {
	startState: EditorState;
	state: EditorState;
	changes: ViewUpdate['changes'];
	wasFocused: boolean;
	isFocused: boolean;
}

/**
 * Identifies reminder lines the cursor just left, so a new reminder gets its ID
 * when the user moves on instead of after the next save and scan. The scan still
 * owns collision repair and lines edited outside an editor.
 */
export function reminderIdChangesForLeftLines({ startState, state, changes, wasFocused, isFocused }: LineLeave): ChangeSpec[] {
	// Lines left by an unfocused editor were not being typed, so the scan writes them.
	if (!wasFocused) return [];
	const { doc } = state;
	// Map back so Enter at a line's end keeps the old cursor on the line it left.
	const previous = new Set(startState.selection.ranges.map(range => doc.lineAt(changes.mapPos(range.head, -1)).number));
	const current = new Set(isFocused ? state.selection.ranges.map(range => doc.lineAt(range.head).number) : []);
	const left = [...previous].filter(line => !current.has(line) && !extractReminderId(doc.line(line).text));
	if (!left.length) return [];
	const normalized = normalizeReminderIds(doc.toString()).content.split('\n');
	return left.flatMap(number => {
		const line = doc.line(number), text = normalized[number - 1];
		return text !== undefined && text !== line.text && extractReminderId(text) ? [{ from: line.from, to: line.to, insert: text }] : [];
	});
}

/** Adds reminder IDs as the cursor leaves a line in an editor `canAssign` accepts. */
export function createReminderLineLeaveExtension(canAssign: (state: EditorState) => boolean) {
	return EditorView.updateListener.of(update => {
		if (!update.selectionSet && !update.focusChanged) return;
		const isFocused = update.view.hasFocus;
		const wasFocused = update.focusChanged ? !isFocused : isFocused;
		if (!canAssign(update.state)) return;
		const changes = reminderIdChangesForLeftLines({ ...update, wasFocused, isFocused });
		if (!changes.length) return;
		// A view cannot dispatch during its own update; skip if the text moved on meanwhile.
		queueMicrotask(() => {
			if (update.view.state.doc === update.state.doc) update.view.dispatch({ changes });
		});
	});
}

const hiddenMarker = Decoration.replace({});

/** A marker that ends its line, which is the span the editor hides and keeps edits out of. */
function endMarker(line: Line): { from: number; to: number } | null {
	const marker = findReminderIdMarker(line.text);
	return marker && line.from + marker.to === line.to ? { from: line.from + marker.from, to: line.to } : null;
}

/** Ranges of reminder ID markers to hide, including the leading space. */
export function hiddenReminderIdRanges(state: EditorState, visible: readonly { from: number; to: number }[]): { from: number; to: number }[] {
	const { doc } = state;
	const ranges: { from: number; to: number }[] = [];
	let last = 0;
	for (const { from, to } of visible) {
		// Adjacent visible ranges can share a line.
		for (let number = Math.max(doc.lineAt(from).number, last + 1); number <= doc.lineAt(to).number; number++) {
			last = number;
			const marker = findReminderIdMarker(doc.line(number).text);
			if (marker) ranges.push({ from: doc.line(number).from + marker.from, to: doc.line(number).from + marker.to });
		}
	}
	return ranges;
}

/**
 * Keeps a hidden marker at its line end, where it names the reminder. Typing,
 * Enter and deletes at the end of a reminder land before the marker, and a
 * forward delete of the marker alone joins the next line instead. Edits the
 * editor cannot see are healed by `normalizeReminderIds`.
 */
export function protectReminderIdMarker(transaction: Transaction): Transaction | TransactionSpec | readonly (Transaction | TransactionSpec)[] {
	const { startState } = transaction;
	if (transaction.docChanged && (transaction.isUserEvent('input') || transaction.isUserEvent('delete'))) {
		const changes: { fromA: number; toA: number; text: string }[] = [];
		transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => changes.push({ fromA, toA, text: inserted.toString() }));
		const [change] = changes;
		const line = change && changes.length === 1 ? startState.doc.lineAt(change.fromA) : null;
		const marker = line && change!.toA <= line.to ? endMarker(line) : null;
		if (line && marker) {
			const { fromA, toA, text } = change!;
			const userEvent = transaction.annotation(Transaction.userEvent);
			const spec = (from: number, to: number, insert: string, cursor: number): TransactionSpec => ({
				changes: { from, to, insert }, selection: { anchor: cursor }, scrollIntoView: true, ...(userEvent ? { userEvent } : {}),
			});
			// Enter before the marker splits after it, so the ID stays on its reminder.
			if (fromA === marker.from && toA === marker.from && text.startsWith('\n')) return spec(line.to, line.to, text, line.to + text.length);
			if (toA > marker.from) {
				// Edits reaching into the marker stop before it.
				if (fromA < marker.from) return spec(fromA, marker.from, text, fromA + text.length);
				if (text) return spec(marker.from, marker.from, text, marker.from + text.length);
				return line.number < startState.doc.lines ? spec(line.to, line.to + 1, '', marker.from) : [];
			}
		}
	}
	if (!transaction.selection) return transaction;
	const { doc } = transaction.state;
	let moved = false;
	const ranges = transaction.newSelection.ranges.map(range => {
		const marker = range.empty ? endMarker(doc.lineAt(range.head)) : null;
		if (!marker || range.head <= marker.from) return range;
		moved = true;
		return EditorSelection.cursor(marker.from);
	});
	return moved ? [transaction, { selection: EditorSelection.create(ranges, transaction.newSelection.mainIndex), sequential: true }] : transaction;
}

/** Hides reminder ID markers in editors `isReminderEditor` accepts and keeps the cursor in front of them. */
export function createReminderIdMarkerHiding(isReminderEditor: (state: EditorState) => boolean) {
	const decorate = (view: EditorView): DecorationSet => isReminderEditor(view.state)
		? Decoration.set(hiddenReminderIdRanges(view.state, view.visibleRanges).map(({ from, to }) => hiddenMarker.range(from, to)))
		: Decoration.none;
	const hiding = ViewPlugin.define(view => ({
		decorations: decorate(view),
		update(update: ViewUpdate) {
			if (update.docChanged || update.viewportChanged) this.decorations = decorate(update.view);
		},
	}), { decorations: plugin => plugin.decorations });
	return [
		hiding,
		EditorView.atomicRanges.of(view => view.plugin(hiding)?.decorations ?? Decoration.none),
		EditorState.transactionFilter.of(transaction => isReminderEditor(transaction.startState) ? protectReminderIdMarker(transaction) : transaction),
	];
}

import { Transaction, type ChangeSpec, type EditorState, type Line, type Text, type TransactionSpec } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { normalizeReminderIds } from '../core/normalizeReminderIds';
import { normalizeReminderScheduleLine } from '../core/normalizeReminderSchedule';
import { extractReminderId, reminderIdMarkers, stripReminderIdMarker } from '../core/reminderIdentity';
import { inlineDescriptionChanges } from '../data/inline-description';
import { markdownTaskContexts } from '../core/markdownTaskContext';
import { TASK_WITH_TEXT } from './reminder-hidden-ranges';
import { datePhraseField } from './editor-date-chips';

/** The part of a view update that decides which lines a cursor left. */
interface LineLeave {
	startState: EditorState;
	state: EditorState;
	changes: ViewUpdate['changes'];
	wasFocused: boolean;
	isFocused: boolean;
}

/** The lines the cursors were on before the update and are on after it, in the new document. */
function cursorLines({ startState, state, changes, isFocused }: LineLeave): { previous: Set<number>; current: Set<number> } {
	const { doc } = state;
	// Map each old cursor's line start: Obsidian's Enter rewrites the line's last character, which would carry the cursor itself along.
	const previous = new Set(startState.selection.ranges.map(range => doc.lineAt(changes.mapPos(startState.doc.lineAt(range.head).from, -1)).number));
	const current = new Set(isFocused ? state.selection.ranges.map(range => doc.lineAt(range.head).number) : []);
	return { previous, current };
}

/** Task lines with text that the cursor just left. */
function leftTaskLines(leave: LineLeave): number[] {
	// Lines left by an unfocused editor were not being typed, so the scan writes them.
	if (!leave.wasFocused) return [];
	const { doc } = leave.state, { previous, current } = cursorLines(leave);
	return [...previous].filter(line => !current.has(line) && TASK_WITH_TEXT.test(doc.line(line).text));
}

const EMPTY_DESCRIPTION = /^<!-- crate-desc:\s*-->$/;

/**
 * The description lines left empty, as deleting all of a description's text leaves them, on the reminders
 * the cursor just left. A description is edited on its own hidden line, so the cursor leaves either line.
 */
function emptiedDescriptionLines(leave: LineLeave): number[] {
	if (!leave.wasFocused) return [];
	const { doc } = leave.state, { previous, current } = cursorLines(leave);
	return [...new Set([...previous].flatMap(line => [line, line + 1]))].filter(line => line > 1 && line <= doc.lines
		&& !current.has(line) && !current.has(line - 1)
		&& EMPTY_DESCRIPTION.test(doc.line(line).text) && TASK_WITH_TEXT.test(doc.line(line - 1).text));
}

/** The change that replaces a line's text with `text`, touching only the span that differs. */
function lineChange(line: Line, text: string): ChangeSpec {
	const before = line.text;
	let start = 0, end = 0;
	while (start < before.length && start < text.length && before[start] === text[start]) start++;
	while (end < before.length - start && end < text.length - start && before[before.length - 1 - end] === text[text.length - 1 - end]) end++;
	return { from: line.from + start, to: line.to - end, insert: text.slice(start, text.length - end) };
}

/**
 * Typed dates saved on the reminder lines among `lineNumbers`. Lines with an ID too: the scan would save them
 * only after the note is written and no sync is running, and until then coming back shows the phrase again.
 * A saved date open as its phrase is left alone: the date chips restore or save it.
 */
function scheduleChanges(state: EditorState, lineNumbers: readonly number[]): ChangeSpec[] {
	const { doc } = state, phrase = state.field(datePhraseField, false);
	const open = phrase && phrase.from <= doc.length ? doc.lineAt(phrase.from).number : 0;
	return lineNumbers.flatMap(number => {
		if (number === open) return [];
		const line = doc.line(number);
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
 * IDs that undo or redo left on a line besides the line's own. IDs are added
 * outside the undo history, so undoing a new reminder's text leaves its ID where
 * that text was: after the line's own ID, which is the first of the markers
 * ending it, or before the next line's text.
 */
export function strayIdChanges(doc: Text, lineNumbers: Iterable<number>): ChangeSpec[] {
	return [...new Set(lineNumbers)].flatMap(number => {
		const line = doc.line(number), markers = reminderIdMarkers(line.text);
		// The markers ending the line, with only spaces and rule markers between them.
		let first = markers.length;
		if (first && !line.text.slice(markers[first - 1]!.to).trim()) {
			first--;
			while (first > 0 && !line.text.slice(markers[first - 1]!.to, markers[first]!.from).replace(RULE_MARKER, '').trim()) first--;
		}
		const task = TASK_WITH_TEXT.test(line.text);
		// A description's comment line, which ends at its closer, never names a reminder.
		const own = !task && stripReminderIdMarker(line.text).trimEnd().endsWith('-->') ? undefined : markers[first];
		// Without an ID ending it, only a line that is no reminder loses its IDs; the scan repairs a reminder's.
		if (!own && task) return [];
		return markers.filter(marker => marker !== own).map(marker => ({ from: line.from + marker.from, to: line.from + marker.to }));
	});
}

const RULE_MARKER = /<!-- crate-(?:rule|done):[^>]*? -->/g;

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
		if (update.docChanged && canAssign(update.state) && update.transactions.some(transaction => transaction.isUserEvent('undo') || transaction.isUserEvent('redo'))) {
			const touched: number[] = [], { doc } = update.state;
			update.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
				for (let number = doc.lineAt(fromB).number; number <= doc.lineAt(toB).number; number++) touched.push(number);
			});
			const stray = strayIdChanges(doc, touched);
			// Outside the history too, like the IDs themselves; a redo's text gets a new ID when the cursor leaves it.
			if (stray.length) queueMicrotask(() => {
				if (update.view.state.doc === doc) update.view.dispatch({ changes: stray, annotations: Transaction.addToHistory.of(false) });
			});
		}
		// Obsidian's Enter in a list sets no selection, so a document change can leave a line too.
		if (!update.docChanged && !update.selectionSet && !update.focusChanged) return;
		const isFocused = update.view.hasFocus;
		const wasFocused = update.focusChanged ? !isFocused : isFocused;
		if (!canAssign(update.state)) return;
		const leave = { ...update, wasFocused, isFocused };
		let left = leftTaskLines(leave);
		const emptied = emptiedDescriptionLines(leave);
		if (!left.length && !emptied.length) return;
		const { view } = update, { doc } = update.state;
		let descriptions = inlineDescriptionChanges(doc, left);
		let dates = descriptions.length ? null : scheduleChanges(update.state, left);
		// Only a line the scan reads as a task is rewritten, not one inside a code block, frontmatter
		// or a comment. Checked only when a leave would write, since it reads the whole note.
		if (descriptions.length || dates?.length) {
			const tasks = markdownTaskContexts(doc.toString().split('\n'));
			const kept = left.filter(number => tasks.has(number - 1));
			if (kept.length !== left.length) {
				left = kept;
				if (!left.length && !emptied.length) return;
				descriptions = inlineDescriptionChanges(doc, left);
				dates = descriptions.length ? null : scheduleChanges(update.state, left);
			}
		}
		// Without a description or date to save the IDs are known now; otherwise they follow the edited lines.
		const known = descriptions.length || dates?.length ? null : reminderIdChanges(update.state.doc, left);
		if (known && !known.length && !emptied.length) return;
		// A view cannot dispatch during its own update; skip if the text moved on meanwhile.
		queueMicrotask(() => {
			if (view.state.doc !== update.state.doc) return;
			let lines = left, blocks = emptied;
			// Undo brings back what each step replaced, so it never leaves half of it.
			const apply = (spec: TransactionSpec) => {
				const before = view.state.doc, transaction = view.state.update(spec);
				view.dispatch(transaction);
				const map = (number: number) => view.state.doc.lineAt(transaction.changes.mapPos(before.line(number).from, -1)).number;
				lines = lines.map(map);
				blocks = blocks.map(map);
			};
			// Filters would keep the block from landing after the line's hidden markers.
			if (descriptions.length) apply({ changes: descriptions, userEvent: 'input.description', filter: false });
			const saved = dates ?? scheduleChanges(view.state, lines);
			if (saved.length) apply({ changes: saved, userEvent: 'input.date', filter: false });
			// Undo would remove the hidden ID unseen, and leaving the line again would mint another.
			const ids = known ?? reminderIdChanges(view.state.doc, lines);
			if (ids.length) view.dispatch({ changes: ids, annotations: Transaction.addToHistory.of(false) });
			// An emptied description goes with the line break before it; a description moved into it meanwhile stays.
			const { doc: now } = view.state;
			const empty = blocks.filter(number => number > 1 && number <= now.lines && EMPTY_DESCRIPTION.test(now.line(number).text));
			if (empty.length) view.dispatch({ changes: empty.map(number => ({ from: now.line(number - 1).to, to: now.line(number).to })), userEvent: 'delete.description', filter: false });
		});
	});
}

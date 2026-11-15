import { EditorSelection, EditorState, StateEffect, StateField, Transaction, type ChangeSpec, type TransactionSpec } from '@codemirror/state';
import { normalizeReminderScheduleLine } from '../core/normalizeReminderSchedule';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { extractReminderId } from '../core/reminderIdentity';
import { createReminderDateChip, editableDatePhrase, reminderLineDisplays, type ReminderDateDisplay } from '../data/reminder-date-display';
import { DescriptionBreakWidget, DescriptionMarkerWidget } from './description-widgets';

/**
 * Schedules on visible lines, relative to the document. A saved date always
 * shows as a chip; a cursor next to it or deleting into it turns it into a
 * phrase to edit until the cursor leaves its line. A typed
 * phrase shows with the date it will save as while the line's title is being
 * written, and as a chip once the cursor moves on, including to a description
 * typed after it. Invalid phrases and typed descriptions show on every line.
 */
export function reminderDateRanges(
	state: EditorState,
	visible: readonly { from: number; to: number }[],
	displayFor: (text: string) => readonly ReminderDateDisplay[] = text => reminderLineDisplays(text),
): ReminderDateDisplay[] {
	const { doc } = state;
	const touches = (from: number, to: number) => state.selection.ranges.some(range => range.from <= to && range.to >= from);
	const found: ReminderDateDisplay[] = [];
	let last = 0;
	for (const { from, to } of visible) {
		// Adjacent visible ranges can share a line.
		for (let number = Math.max(doc.lineAt(from).number, last + 1); number <= doc.lineAt(to).number; number++) {
			last = number;
			const line = doc.line(number), displays = displayFor(line.text);
			const description = displays.find(display => display.kind === 'description');
			const title = touches(line.from, line.from + (description?.from ?? line.length));
			for (const display of displays) {
				const at = {
					from: line.from + display.from,
					to: line.from + display.to,
					...display.kind === 'description' ? { start: line.from + display.start, breaks: display.breaks.map(position => line.from + position) } : {},
				};
				found.push(display.kind === 'phrase' && !title ? { ...display, ...at, kind: 'chip', typed: true } : { ...display, ...at });
			}
		}
	}
	return found;
}

/**
 * Backspace at the end of a saved date's chip, or forward delete at its start,
 * turns the date into a phrase to edit, such as `tomorrow 12:00`, which saving
 * turns back into the date. A date no phrase reproduces is deleted whole.
 */
export function editDateChip(transaction: Transaction, now = new Date()): TransactionSpec | null {
	const backward = transaction.isUserEvent('delete.backward'), forward = transaction.isUserEvent('delete.forward');
	if (!transaction.docChanged || !(backward || forward)) return null;
	let only: { from: number; to: number } | null = null, count = 0;
	transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => { count++; only = inserted.length ? null : { from, to }; });
	const change = count === 1 ? only as { from: number; to: number } | null : null;
	if (!change) return null;
	const line = transaction.startState.doc.lineAt(change.from);
	if (change.to > line.to) return null;
	const chip = reminderLineDisplays(line.text, now).find(display => display.kind === 'chip');
	if (chip?.kind !== 'chip') return null;
	const from = line.from + chip.from, to = line.from + chip.to;
	if (!(backward ? change.to === to && change.from >= from : change.from === from && change.to <= to)) return null;
	const editable = editableDatePhrase(line.text, now), userEvent = transaction.annotation(Transaction.userEvent);
	if (editable) return showPhrase(from, to, line.text.slice(chip.from, chip.to), editable.phrase, backward, userEvent);
	return { changes: { from, to }, selection: { anchor: from }, ...userEvent ? { userEvent } : {} };
}

/** A saved date shown as a phrase while its line is edited, to restore or save when the cursor leaves. */
interface DatePhrase {
	from: number;
	to: number;
	phrase: string;
	stored: string;
}

const setDatePhrase = StateEffect.define<DatePhrase | null>();

/** Exported for tests. */
export const datePhraseField = StateField.define<DatePhrase | null>({
	create: () => null,
	update(value, transaction) {
		for (const effect of transaction.effects) if (effect.is(setDatePhrase)) return effect.value;
		// Typing at either end of the phrase extends it.
		return value && transaction.docChanged
			? { ...value, from: transaction.changes.mapPos(value.from, -1), to: transaction.changes.mapPos(value.to, 1) }
			: value;
	},
});

/** Replaces a saved date with its phrase and remembers it; the cursor goes to the phrase's start or end. */
function showPhrase(from: number, to: number, stored: string, phrase: string, atEnd: boolean, userEvent?: string): TransactionSpec {
	return {
		changes: { from, to, insert: phrase },
		selection: { anchor: atEnd ? from + phrase.length : from },
		effects: setDatePhrase.of({ from, to: from + phrase.length, phrase, stored }),
		// Leaving the line restores or saves the date, so undo skips this step.
		annotations: Transaction.addToHistory.of(false),
		...userEvent ? { userEvent } : {},
	};
}

/**
 * A cursor the user moved next to a saved date's chip, by click or key, turns
 * the date into a phrase to edit. Called with the settled selection, after
 * other filters moved it, and the one before the move. Arriving from after the chip keeps the cursor at the
 * phrase's end; arriving at its start from before keeps it at the start.
 * Selections leave chips alone, and a date no phrase reproduces stays a chip.
 */
export function openDateChip(state: EditorState, previous: EditorSelection, now = new Date()): TransactionSpec | null {
	const after = state.selection;
	if (after.ranges.length !== 1 || !after.main.empty) return null;
	const start = previous.main.head, head = after.main.head, line = state.doc.lineAt(head);
	const editable = editableDatePhrase(line.text, now);
	if (!editable) return null;
	const from = line.from + editable.from, to = line.from + editable.to;
	if ((head !== from && head !== to) || (previous.ranges.length === 1 && previous.main.empty && start === head)) return null;
	return showPhrase(from, to, line.text.slice(editable.from, editable.to), editable.phrase, head === to || start === to);
}

/**
 * A saved date that opens its reminder for editing, or selects its text on a
 * reminder with no ID yet. A typed date not saved yet always selects its text.
 */
class DateChipWidget extends WidgetType {
	constructor(readonly label: string, readonly overdue: boolean, readonly typed: boolean, readonly length: number, readonly open: (reminderId: string) => void) { super(); }

	eq(other: DateChipWidget) {
		return other.label === this.label && other.overdue === this.overdue && other.typed === this.typed && other.length === this.length;
	}

	toDOM(view: EditorView) {
		return createReminderDateChip(this.label, this.overdue, element => {
			const position = view.posAtDOM(element), id = extractReminderId(view.state.doc.lineAt(position).text);
			if (id && !this.typed) this.open(id);
			else {
				// The chip keeps presses from focusing the editor, so typing would go nowhere.
				view.focus();
				view.dispatch({ selection: { anchor: position, head: position + this.length } });
			}
		});
	}

	// The chip handles its own presses, so the editor never places a cursor under it.
	ignoreEvent() { return true; }
}

/** The date a typed phrase will be saved as, after the line's text. */
class DateHintWidget extends WidgetType {
	constructor(readonly label: string) { super(); }

	eq(other: DateHintWidget) { return other.label === this.label; }

	toDOM() {
		return createSpan({ cls: 'crate-reminder-date-hint', text: this.label, attr: { 'aria-hidden': 'true' } });
	}
}

const phraseMark = Decoration.mark({ class: 'crate-reminder-date-phrase' });
// Styled, not replaced: the `!` reads as itself, so the cursor and deletes stay native.
const importantMark = Decoration.mark({ class: 'crate-reminder-important' });
const descriptionMarker = Decoration.replace({ widget: new DescriptionMarkerWidget() });
const SEPARATOR_LENGTH = ' //'.length;
const descriptionMark = Decoration.mark({ class: 'crate-reminder-description-phrase' });

/** What the decorations show, to redraw only when passing time changes a label. */
const displayKey = (displays: ReminderDateDisplay[]) => displays.map(display =>
	display.kind === 'chip' ? `${display.label}${display.overdue ? '!' : ''}` : display.kind === 'phrase' ? display.label : display.kind === 'error' ? display.message : '').join('\n');

const descriptionBreak = Decoration.replace({ widget: new DescriptionBreakWidget() });

/**
 * What leaving a date phrase's line writes: the stored date back when the phrase
 * is unchanged, so the note is as it was, or the line saved with the edited
 * phrase, which the scan would otherwise save later.
 */
export function leavePhrase(state: EditorState, { from, to, phrase, stored }: DatePhrase): { changes: ChangeSpec[]; restored: boolean } {
	const { doc } = state;
	if (from > to || to > doc.length) return { changes: [], restored: false };
	if (doc.sliceString(from, to) === phrase) return { changes: [{ from, to, insert: stored }], restored: true };
	const line = doc.lineAt(from);
	let saved: string;
	try { saved = normalizeReminderScheduleLine(line.text); } catch { return { changes: [], restored: false }; }
	if (saved === line.text) return { changes: [], restored: false };
	// Only the span that differs, so the line's hidden markers stay as they are.
	let start = 0, end = 0;
	while (start < line.text.length && start < saved.length && line.text[start] === saved[start]) start++;
	while (end < line.text.length - start && end < saved.length - start && line.text[line.text.length - 1 - end] === saved[saved.length - 1 - end]) end++;
	return { changes: [{ from: line.from + start, to: line.to - end, insert: saved.slice(start, saved.length - end) }], restored: false };
}

/**
 * Shows saved reminder dates as chips that open their reminder, underlines typed
 * date phrases with the date they will be saved as, marks phrases that cannot
 * become a date and typed descriptions, in editors `isReminderEditor` accepts.
 * Labels follow the clock.
 */
export function createReminderDateChips(isReminderEditor: (state: EditorState) => boolean, openReminder: (reminderId: string) => void) {
	// Moving the cursor redraws the chips, so parsed lines are kept until the minute changes the labels.
	let cache = new Map<string, readonly ReminderDateDisplay[]>(), minute = 0;
	const displayFor = (text: string) => {
		const now = new Date(), current = Math.floor(now.getTime() / 60_000);
		if (current !== minute || cache.size > 2000) { cache = new Map(); minute = current; }
		if (!cache.has(text)) cache.set(text, reminderLineDisplays(text, now));
		return cache.get(text)!;
	};
	const decorate = (view: EditorView): { decorations: DecorationSet; chips: DecorationSet; key: string } => {
		if (!isReminderEditor(view.state)) return { decorations: Decoration.none, chips: Decoration.none, key: '' };
		const { doc } = view.state, displays = reminderDateRanges(view.state, view.visibleRanges, displayFor);
		const decorations = Decoration.set(displays.flatMap(display => {
			const { from, to } = display;
			if (display.kind === 'chip') {
				return [Decoration.replace({ widget: new DateChipWidget(display.label, display.overdue, Boolean(display.typed), to - from, openReminder) }).range(from, to)];
			}
			if (display.kind === 'description') {
				const { start, breaks } = display;
				return [
					descriptionMarker.range(from, start),
					...start < to ? [descriptionMark.range(start, to)] : [],
					...breaks.map(position => descriptionBreak.range(position, position + SEPARATOR_LENGTH)),
				];
			}
			if (display.kind === 'important') return [importantMark.range(from, to)];
			if (display.kind === 'error') {
				return [Decoration.mark({ class: 'crate-reminder-date-error', attributes: { title: display.message, 'aria-invalid': 'true' } }).range(from, to)];
			}
			return [
				phraseMark.range(from, to),
				// At the line's end, so typing never moves around it.
				Decoration.widget({ widget: new DateHintWidget(display.label), side: 1 }).range(doc.lineAt(from).to),
			];
		}), true);
		const chips = Decoration.set(displays.flatMap(display => {
			const { kind, from, to } = display;
			if (kind === 'description') {
				return [from, ...display.breaks].map((position, index) => Decoration.mark({}).range(position, index ? position + SEPARATOR_LENGTH : display.start));
			}
			return kind === 'chip' ? [Decoration.mark({}).range(from, to)] : [];
		}));
		return { decorations, chips, key: displayKey(displays) };
	};
	const plugin = ViewPlugin.define(view => {
		let { decorations, chips, key } = decorate(view);
		// "Today", "Tomorrow" and overdue change with the clock, not only with edits.
		const timer = window.setInterval(() => {
			const next = decorate(view);
			if (next.key === key) return;
			({ decorations, chips, key } = next);
			view.dispatch({});
		}, 60_000);
		return {
			get decorations() { return decorations; },
			get chips() { return chips; },
			update(update: ViewUpdate) {
				// Switching to source mode changes only the editor's state.
				const toggled = isReminderEditor(update.startState) !== isReminderEditor(update.state);
				if (toggled || update.docChanged || update.viewportChanged || update.selectionSet) ({ decorations, chips, key } = decorate(update.view));
			},
			destroy() { window.clearInterval(timer); },
		};
	}, { decorations: value => value.decorations });
	// Chips and description markers move and delete as one, like the text they stand for.
	return [
		plugin,
		EditorView.atomicRanges.of(view => view.plugin(plugin)?.chips ?? Decoration.none),
		EditorState.transactionFilter.of(transaction => isReminderEditor(transaction.startState)
			? editDateChip(transaction) ?? transaction : transaction),
		datePhraseField,
		EditorView.updateListener.of(update => {
			const phrase = update.state.field(datePhraseField, false), { doc } = update.state;
			if (!phrase) {
				const moved = update.selectionSet && !update.docChanged && update.view.hasFocus && isReminderEditor(update.state)
					&& update.transactions.some(transaction => transaction.isUserEvent('select'));
				const open = moved ? openDateChip(update.state, update.startState.selection) : null;
				// A click can send more updates that change nothing; skip only if the text or cursor moved on.
				if (open) queueMicrotask(() => {
					const { state } = update.view;
					if (state.doc === update.state.doc && state.selection.eq(update.state.selection)) update.view.dispatch(open);
				});
				return;
			}
			const line = doc.lineAt(Math.min(phrase.from, doc.length)).number;
			if (update.view.hasFocus && update.state.selection.ranges.some(range => doc.lineAt(range.head).number === line)) return;
			const { changes, restored } = leavePhrase(update.state, phrase);
			// A view cannot dispatch during its own update; skip if the text moved on meanwhile.
			queueMicrotask(() => {
				if (update.view.state.doc !== update.state.doc) return;
				// Restoring undoes the phrase, which undo never saw; a saved edit is undone like the typing before it.
				// Typing rules would treat a save as typing at the line's end; it is not.
				update.view.dispatch({ changes, effects: setDatePhrase.of(null), filter: false, ...restored ? { annotations: Transaction.addToHistory.of(false) } : { userEvent: 'input.date' } });
			});
		}),
	];
}

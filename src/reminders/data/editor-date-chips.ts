import type { EditorState } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { extractReminderId } from '../core/reminderIdentity';
import { createReminderDateChip, reminderDateDisplay, type ReminderDateDisplay } from './reminder-date-display';

/**
 * Schedules on visible lines, relative to the document. A chip shows only on lines
 * with no cursor or selection, which show the saved text to be edited; typed and
 * invalid phrases show on every line, so they read while being written.
 */
export function reminderDateRanges(
	state: EditorState,
	visible: readonly { from: number; to: number }[],
	displayFor: (text: string) => ReminderDateDisplay | null = text => reminderDateDisplay(text),
): ReminderDateDisplay[] {
	const { doc } = state;
	const editing = new Set<number>();
	for (const range of state.selection.ranges) {
		for (let number = doc.lineAt(range.from).number; number <= doc.lineAt(range.to).number; number++) editing.add(number);
	}
	const found: ReminderDateDisplay[] = [];
	let last = 0;
	for (const { from, to } of visible) {
		// Adjacent visible ranges can share a line.
		for (let number = Math.max(doc.lineAt(from).number, last + 1); number <= doc.lineAt(to).number; number++) {
			last = number;
			const line = doc.line(number), display = displayFor(line.text);
			if (display && !(display.kind === 'chip' && editing.has(number))) found.push({ ...display, from: line.from + display.from, to: line.from + display.to });
		}
	}
	return found;
}

/** A saved date that opens its reminder for editing, or shows its text on a reminder with no ID yet. */
class DateChipWidget extends WidgetType {
	constructor(readonly label: string, readonly overdue: boolean, readonly open: (reminderId: string) => void) { super(); }

	eq(other: DateChipWidget) { return other.label === this.label && other.overdue === this.overdue; }

	toDOM(view: EditorView) {
		return createReminderDateChip(this.label, this.overdue, element => {
			const position = view.posAtDOM(element), id = extractReminderId(view.state.doc.lineAt(position).text);
			if (id) this.open(id);
			else view.dispatch({ selection: { anchor: position } });
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

/** What the decorations show, to redraw only when passing time changes a label. */
const displayKey = (displays: ReminderDateDisplay[]) => displays.map(display =>
	display.kind === 'chip' ? `${display.label}${display.overdue ? '!' : ''}` : display.kind === 'phrase' ? display.label : display.message).join('\n');

/**
 * Shows saved reminder dates as chips that open their reminder, underlines typed
 * date phrases with the date they will be saved as, and marks phrases that cannot
 * become a date, in editors `isReminderEditor` accepts. Labels follow the clock.
 */
export function createReminderDateChips(isReminderEditor: (state: EditorState) => boolean, openReminder: (reminderId: string) => void) {
	// Moving the cursor redraws the chips, so parsed lines are kept until the minute changes the labels.
	let cache = new Map<string, ReminderDateDisplay | null>(), minute = 0;
	const displayFor = (text: string) => {
		const now = new Date(), current = Math.floor(now.getTime() / 60_000);
		if (current !== minute || cache.size > 2000) { cache = new Map(); minute = current; }
		if (!cache.has(text)) cache.set(text, reminderDateDisplay(text, now));
		return cache.get(text)!;
	};
	const decorate = (view: EditorView): { decorations: DecorationSet; key: string } => {
		if (!isReminderEditor(view.state)) return { decorations: Decoration.none, key: '' };
		const { doc } = view.state, displays = reminderDateRanges(view.state, view.visibleRanges, displayFor);
		const decorations = Decoration.set(displays.flatMap(display => {
			const { from, to } = display;
			if (display.kind === 'chip') return [Decoration.replace({ widget: new DateChipWidget(display.label, display.overdue, openReminder) }).range(from, to)];
			if (display.kind === 'error') {
				return [Decoration.mark({ class: 'crate-reminder-date-error', attributes: { title: display.message, 'aria-invalid': 'true' } }).range(from, to)];
			}
			return [
				phraseMark.range(from, to),
				// At the line's end, so typing never moves around it.
				Decoration.widget({ widget: new DateHintWidget(display.label), side: 1 }).range(doc.lineAt(from).to),
			];
		}), true);
		return { decorations, key: displayKey(displays) };
	};
	return ViewPlugin.define(view => {
		let { decorations, key } = decorate(view);
		// "Today", "Tomorrow" and overdue change with the clock, not only with edits.
		const timer = window.setInterval(() => {
			const next = decorate(view);
			if (next.key === key) return;
			({ decorations, key } = next);
			view.dispatch({});
		}, 60_000);
		return {
			get decorations() { return decorations; },
			update(update: ViewUpdate) {
				// Switching to source mode changes only the editor's state.
				const toggled = isReminderEditor(update.startState) !== isReminderEditor(update.state);
				if (toggled || update.docChanged || update.viewportChanged || update.selectionSet) ({ decorations, key } = decorate(update.view));
			},
			destroy() { window.clearInterval(timer); },
		};
	}, { decorations: plugin => plugin.decorations });
}

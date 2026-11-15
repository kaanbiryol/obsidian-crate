import { EditorState, StateField, type EditorSelection, type Line, type Text, type Transaction } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { extractReminderId } from '../core/reminderIdentity';
import { DescriptionBreakWidget, DescriptionMarkerWidget } from './description-widgets';
import { TEXT_START, editableDescription, hasCommentMarker, hiddenDescriptionRanges, hiddenReminderMarkerRanges, reminderClipboard, revealedDescriptions, tailEndingAt } from './reminder-hidden-ranges';
import { protectReminderIdMarker } from './reminder-marker-protection';

const hiddenMarker = Decoration.replace({});
const descriptionMarker = Decoration.replace({ widget: new DescriptionMarkerWidget() });
const descriptionBreak = Decoration.replace({ widget: new DescriptionBreakWidget() });
const descriptionText = Decoration.mark({ class: 'crate-reminder-description-source' });

/** Revealed reminder line starts, moved through a change. */
const mapRevealed = (revealed: string, transaction: Transaction) =>
	revealed ? revealed.split(',').map(from => transaction.changes.mapPos(Number(from))).sort((a, b) => a - b).join() : '';

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

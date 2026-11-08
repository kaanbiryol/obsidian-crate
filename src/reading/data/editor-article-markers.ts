import { EditorSelection, EditorState, StateField, Transaction, type ChangeSpec, type Text, type TransactionSpec } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { ARTICLE_END, ARTICLE_START } from '../core/model';

interface Span { from: number; to: number }
/** The start and end marker lines of a note's managed article. */
export interface ArticleMarkers { start: Span; end: Span }

const MARKER_KEY = 'crate:article';

function count(text: string, marker: string): number {
	return text.split(marker).length - 1;
}

/**
 * The article's marker lines when the note has exactly one of each, each alone
 * on its line, start first. Anything else stays visible so it can be repaired.
 */
export function findArticleMarkers(doc: Text): ArticleMarkers | null {
	let start: Span | null = null, end: Span | null = null, starts = 0, ends = 0;
	for (let number = 1; number <= doc.lines; number++) {
		const line = doc.line(number);
		if (!line.text.includes(MARKER_KEY)) continue;
		starts += count(line.text, ARTICLE_START);
		ends += count(line.text, ARTICLE_END);
		if (line.text === ARTICLE_START) start = { from: line.from, to: line.to };
		if (line.text === ARTICLE_END) end = { from: line.from, to: line.to };
	}
	return start && end && starts === 1 && ends === 1 && start.to < end.from ? { start, end } : null;
}

/** Adjacent markers wrap an empty article, with no line between them. */
const adjacent = ({ start, end }: ArticleMarkers) => end.from === start.to + 1;

/** What the editor hides: each marker line with the line break on its article side. */
function hiddenSpans(markers: ArticleMarkers): Span[] {
	const { start, end } = markers;
	return adjacent(markers) ? [{ from: start.from, to: end.to }] : [{ from: start.from, to: start.to + 1 }, { from: end.from - 1, to: end.to }];
}

/**
 * Spans user edits never delete from, each marker line with both its line
 * breaks, and where text or a cursor inside one lands instead: inside the
 * article, or after an empty article.
 */
function protectedSpans(markers: ArticleMarkers, doc: Text): (Span & { landing: number })[] {
	const { start, end } = markers;
	// Spans may reach one past the document, so a cursor at its end still counts as inside.
	if (adjacent(markers)) return [{ from: start.from - 1, to: end.to + 1, landing: end.to < doc.length ? end.to + 1 : Math.max(start.from - 1, 0) }];
	return [{ from: start.from - 1, to: start.to + 1, landing: start.to + 1 }, { from: end.from - 1, to: end.to + 1, landing: end.from - 1 }];
}

/** `from`–`to` without the protected spans. */
function subtract(from: number, to: number, spans: readonly Span[]): Span[] {
	let pieces: Span[] = [{ from, to }];
	for (const span of spans) {
		pieces = pieces.flatMap(piece => piece.to <= span.from || piece.from >= span.to ? [piece]
			: [{ from: piece.from, to: span.from }, { from: span.to, to: piece.to }].filter(part => part.to > part.from));
	}
	return pieces;
}

/**
 * Keeps user edits from removing one article marker or moving text across one.
 * Typing next to a hidden marker lands inside the article, and Backspace or
 * Delete into a marker does nothing. Deleting a selection of the whole article
 * deletes both markers with it. Edits by Crate pass unchanged.
 */
function protectArticleMarkers(
	transaction: Transaction,
	markersOf: (state: EditorState) => ArticleMarkers | null,
): Transaction | TransactionSpec | readonly (Transaction | TransactionSpec)[] {
	const { startState } = transaction;
	const markers = markersOf(startState);
	if (!markers) return transaction;
	const { doc } = startState;
	if (transaction.docChanged && (transaction.isUserEvent('input') || transaction.isUserEvent('delete') || transaction.isUserEvent('move'))) {
		const spans = protectedSpans(markers, doc);
		const changes: { fromA: number; toA: number; text: string }[] = [];
		transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => changes.push({ fromA, toA, text: inserted.toString() }));
		const touches = ({ fromA, toA }: { fromA: number; toA: number }) => spans.some(span => fromA < span.to && toA > span.from && !(fromA === toA && (fromA === span.from || fromA === span.to)));
		const { start, end } = markers;
		// Deleting a selection of the whole article takes its markers along, so no empty pair is left behind.
		const wholeArticle = ({ fromA, toA, text }: { fromA: number; toA: number; text: string }) => !text && !adjacent(markers) && fromA <= start.to + 1 && toA >= end.from - 1
			&& startState.selection.ranges.some(range => !range.empty && range.from <= fromA && range.to >= toA);
		if (!changes.some(change => touches(change) || wholeArticle(change))) return transaction;
		const specs: ChangeSpec[] = [];
		let cursor: number | null = null;
		for (const change of changes) {
			const { fromA, toA, text } = change;
			let next: { from: number; to?: number; insert: string }[];
			if (fromA <= start.from && toA >= end.to) next = [{ from: fromA, to: toA, insert: text }];
			else if (wholeArticle(change)) next = [{ from: Math.min(fromA, start.from), to: Math.max(toA, end.to), insert: '' }];
			else if (!touches(change)) next = [{ from: fromA, to: toA, insert: text }];
			else {
				const pieces = subtract(fromA, toA, spans);
				next = pieces.map((piece, index) => ({ ...piece, insert: index ? '' : text }));
				if (!pieces.length && text) next = [{ from: spans.find(span => fromA >= span.from && fromA <= span.to)!.landing, insert: text }];
			}
			if (changes.length === 1 && next[0]) cursor = next[0].from;
			specs.push(...next);
		}
		if (!specs.length) return [];
		const set = startState.changes(specs);
		if (set.empty) return [];
		const userEvent = transaction.annotation(Transaction.userEvent);
		return { changes: set, scrollIntoView: true, ...(cursor === null ? {} : { selection: { anchor: set.mapPos(cursor, 1) } }), ...(userEvent ? { userEvent } : {}) };
	}
	if (!transaction.selection) return transaction;
	const next = markersOf(transaction.state);
	if (!next) return transaction;
	const spans = protectedSpans(next, transaction.state.doc);
	let moved = false;
	const ranges = transaction.newSelection.ranges.map(range => {
		// Inside a span but off its line breaks is on a hidden marker line.
		const span = range.empty ? spans.find(span => range.head > span.from && range.head < span.to) : undefined;
		if (!span || span.landing === range.head) return range;
		moved = true;
		return EditorSelection.cursor(span.landing);
	});
	return moved ? [transaction, { selection: EditorSelection.create(ranges, transaction.newSelection.mainIndex), sequential: true }] : transaction;
}

/** Whether `transaction` may have added, removed or changed a marker. */
function touchesMarkers(transaction: Transaction, markers: ArticleMarkers | null): boolean {
	let touched = false;
	const { doc } = transaction.state;
	transaction.changes.iterChanges((fromA, toA, fromB, toB) => {
		if (touched) return;
		if (markers && fromA <= markers.end.to + 1 && toA >= markers.start.from - 1
			&& protectedSpans(markers, transaction.startState.doc).some(span => fromA <= span.to && toA >= span.from)) touched = true;
		else if (transaction.startState.sliceDoc(fromA, toA).includes(MARKER_KEY)) touched = true;
		else for (let number = doc.lineAt(fromB).number; number <= doc.lineAt(toB).number && !touched; number++) touched = doc.line(number).text.includes(MARKER_KEY);
	});
	return touched;
}

/** Hides article markers in editors `isReadingEditor` accepts, and keeps edits from breaking them. */
export function createArticleMarkerHiding(isReadingEditor: (state: EditorState) => boolean) {
	const decorate = (markers: ArticleMarkers | null): DecorationSet => markers
		? Decoration.set(hiddenSpans(markers).map(({ from, to }) => Decoration.replace({}).range(from, to)))
		: Decoration.none;
	const read = (state: EditorState) => {
		const markers = isReadingEditor(state) ? findArticleMarkers(state.doc) : null;
		return { markers, decorations: decorate(markers) };
	};
	// Replacing line breaks changes line layout, which only a state field may do.
	const article = StateField.define<{ markers: ArticleMarkers | null; decorations: DecorationSet }>({
		create: read,
		update(value, transaction) {
			if (!transaction.docChanged) return value;
			if (touchesMarkers(transaction, value.markers)) return read(transaction.state);
			if (!value.markers) return value;
			// Edits elsewhere only move the markers.
			const map = ({ from, to }: Span) => ({ from: transaction.changes.mapPos(from, 1), to: transaction.changes.mapPos(to, -1) });
			const markers = { start: map(value.markers.start), end: map(value.markers.end) };
			return { markers, decorations: decorate(markers) };
		},
		provide: field => [
			EditorView.decorations.from(field, value => value.decorations),
			EditorView.atomicRanges.of(view => view.state.field(field, false)?.decorations ?? Decoration.none),
		],
	});
	return [
		article,
		EditorState.transactionFilter.of(transaction => protectArticleMarkers(transaction, state => state.field(article, false)?.markers ?? null)),
	];
}

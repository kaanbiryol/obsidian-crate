import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ARTICLE_END, ARTICLE_START } from '../core/model';
import { createArticleMarkerHiding, findArticleMarkers } from './editor-article-markers';

const head = '---\ntitle: "A"\n---\n';
const note = `${head}${ARTICLE_START}\nFirst\nLast\n${ARTICLE_END}\nMy notes`;
const articleFrom = note.indexOf('First'), articleTo = note.indexOf('Last') + 'Last'.length;

function state(doc: string, anchor = 0, cursor = anchor, reading = true) {
	return EditorState.create({ doc, selection: EditorSelection.single(anchor, cursor), extensions: createArticleMarkerHiding(() => reading) });
}

function edit(doc: string, cursor: number, spec: TransactionSpec, anchor = cursor) {
	const next = state(doc, anchor, cursor).update(spec).state;
	return { text: next.doc.toString(), cursor: next.selection.main.head };
}

function hidden(doc: string, reading = true) {
	const decorations = state(doc, 0, 0, reading).facet(EditorView.decorations).map(source => typeof source === 'function' ? null : source);
	const ranges: string[] = [];
	for (const set of decorations) set?.between(0, doc.length, (from, to) => { ranges.push(doc.slice(from, to)); });
	return ranges;
}

describe('article marker hiding', () => {
	it('hides each marker line with the line break on its article side', () => {
		expect(hidden(note)).toEqual([`${ARTICLE_START}\n`, `\n${ARTICLE_END}`]);
	});

	it('hides both lines of an empty article as one span', () => {
		expect(hidden(`${head}${ARTICLE_START}\n${ARTICLE_END}\n`)).toEqual([`${ARTICLE_START}\n${ARTICLE_END}`]);
	});

	it('leaves broken, duplicate and inline markers visible, and notes outside Reading alone', () => {
		expect(findArticleMarkers(state(`${head}${ARTICLE_START}\nText`).doc)).toBeNull();
		expect(findArticleMarkers(state(`${note}\n${ARTICLE_END}`).doc)).toBeNull();
		expect(findArticleMarkers(state(`${head}Intro ${ARTICLE_START}\nText\n${ARTICLE_END}`).doc)).toBeNull();
		expect(findArticleMarkers(state(`${head}${ARTICLE_END}\nText\n${ARTICLE_START}`).doc)).toBeNull();
		expect(hidden(note, false)).toEqual([]);
	});

	it('follows the markers through edits elsewhere and stops hiding a marker that breaks', () => {
		const typed = state(note).update({ changes: { from: articleFrom, insert: 'New\n' } }).state;
		const ranges: string[] = [];
		for (const source of typed.facet(EditorView.decorations)) if (typeof source !== 'function') source.between(0, typed.doc.length, (from, to) => { ranges.push(typed.doc.sliceString(from, to)); });
		expect(ranges).toEqual([`${ARTICLE_START}\n`, `\n${ARTICLE_END}`]);
		const broken = state(note).update({ changes: { from: note.indexOf(ARTICLE_END), to: note.indexOf(ARTICLE_END) + 6 } }).state;
		expect(broken.facet(EditorView.decorations).some(source => typeof source !== 'function' && source.size)).toBe(false);
	});
});

describe('article marker protection', () => {
	it('keeps the cursor inside the article next to a hidden marker', () => {
		expect(edit(note, 0, { selection: { anchor: note.indexOf(ARTICLE_START) } }).cursor).toBe(articleFrom);
		expect(edit(note, 0, { selection: { anchor: note.indexOf(ARTICLE_END) + ARTICLE_END.length } }).cursor).toBe(articleTo);
	});

	it('types inside the article when an insert lands on a marker line', () => {
		const at = note.indexOf(ARTICLE_START);
		expect(edit(note, at, { changes: { from: at, insert: 'x' }, userEvent: 'input.type' })).toEqual({ text: note.replace('First', 'xFirst'), cursor: articleFrom + 1 });
	});

	it('ignores Backspace and Delete into a marker, so no text crosses it', () => {
		// The editor skips the hidden span, so these cover the marker line.
		expect(edit(note, articleFrom, { changes: { from: note.indexOf(ARTICLE_START), to: articleFrom }, userEvent: 'delete.backward' }).text).toBe(note);
		expect(edit(note, articleTo, { changes: { from: articleTo, to: note.indexOf(ARTICLE_END) + ARTICLE_END.length }, userEvent: 'delete.forward' }).text).toBe(note);
		const notes = note.indexOf('My notes');
		expect(edit(note, notes, { changes: { from: notes - 1, to: notes }, userEvent: 'delete.backward' }).text).toBe(note);
		const markerLine = note.indexOf(ARTICLE_START);
		expect(edit(note, markerLine - 1, { changes: { from: markerLine - 1, to: markerLine }, userEvent: 'delete.forward' }).text).toBe(note);
	});

	it('keeps the marker when a selection deletes across it', () => {
		const from = note.indexOf('title'), to = note.indexOf('irst');
		expect(edit(note, to, { changes: { from, to }, userEvent: 'delete.selection' }, from).text).toBe(`---\n\n${ARTICLE_START}\nirst\nLast\n${ARTICLE_END}\nMy notes`);
		const into = note.indexOf('notes');
		expect(edit(note, into, { changes: { from: note.indexOf('ast'), to: into, insert: '!' }, userEvent: 'input.type' }, note.indexOf('ast')).text)
			.toBe(`${head}${ARTICLE_START}\nFirst\nL!\n${ARTICLE_END}\nnotes`);
	});

	it('deletes both markers with a selection of the whole article', () => {
		expect(edit(note, articleTo, { changes: { from: articleFrom, to: articleTo }, userEvent: 'delete.cut' }, articleFrom)).toEqual({ text: `${head}\nMy notes`, cursor: head.length });
		expect(edit(note, note.length, { changes: { from: 0, to: note.length }, userEvent: 'delete.selection' }, 0).text).toBe('');
		// Typing over the whole article replaces its text and keeps the markers.
		expect(edit(note, articleTo, { changes: { from: articleFrom, to: articleTo, insert: 'New' }, userEvent: 'input.type' }, articleFrom).text)
			.toBe(`${head}${ARTICLE_START}\nNew\n${ARTICLE_END}\nMy notes`);
	});

	it('keeps edits inside the article and edits by Crate unchanged', () => {
		expect(edit(note, articleFrom, { changes: { from: articleFrom, insert: '\n' }, userEvent: 'input' }).text).toBe(note.replace('First', '\nFirst'));
		expect(edit(note, articleTo, { changes: { from: articleTo, insert: '\nMore' }, userEvent: 'input' }).text).toBe(note.replace('Last', 'Last\nMore'));
		expect(edit(note, 0, { changes: { from: note.indexOf(ARTICLE_START), to: articleFrom } }).text).toBe(note.replace(`${ARTICLE_START}\n`, ''));
	});

	it('keeps an empty article intact and moves the cursor after it', () => {
		const empty = `${head}${ARTICLE_START}\n${ARTICLE_END}\n`;
		expect(edit(empty, 0, { selection: { anchor: empty.indexOf(ARTICLE_END) } }).cursor).toBe(empty.length);
		expect(edit(empty, empty.length, { changes: { from: empty.length - 1, to: empty.length }, userEvent: 'delete.backward' }).text).toBe(empty);
	});
});

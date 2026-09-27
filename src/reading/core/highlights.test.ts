import { expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { readingHighlights, matchingHighlights } from './highlights';
import { createReadingNote, parseReadingNote, updateReadingNote } from './notes';
import { paintHighlights, resizeHighlight } from '../ui/reader-highlights';

const highlight = { start: 0, end: 5, text: 'Hello' };
it('round trips highlights without changing the article or other metadata', () => {
	const note = createReadingNote({ id: crypto.randomUUID(), url: 'https://example.com', savedAt: '2026-09-26T00:00:00Z' }) + '\nHello **world**!\n';
	const id = parseReadingNote(note)!.crate_reading_id;
	const updated = updateReadingNote(note, id, { highlights: [highlight] });
	expect(parseReadingNote(updated)?.highlights).toEqual([highlight]);
	expect(updated.endsWith('\nHello **world**!\n')).toBe(true);
	expect(parseReadingNote(updateReadingNote(updated, id, { favorite: true }))?.highlights).toEqual([highlight]);
	expect(parseReadingNote(updateReadingNote(updated, id, { highlights: [] }))?.highlights).toEqual([]);
});
it('rejects malformed and oversized anchors and refuses mismatched text', () => {
	for (const value of [null, [{ ...highlight, start: -1 }], [{ ...highlight, end: 3 }], Array(101).fill(highlight)]) expect(() => readingHighlights(value)).toThrow();
	expect(matchingHighlights('Changed text', [highlight])).toEqual([]);
});
it('highlights across formatting and paragraphs without altering text or links', () => {
	const { document } = parseHTML('<html><body><div>Hello <em>world</em>!</div><p>Next paragraph.</p></body></html>');
	const body = document.body as unknown as HTMLElement;
	const text = body.textContent!;
	paintHighlights(body, [{ start: 3, end: 15, text: text.slice(3, 15) }, { start: 6, end: 11, text: 'world' }]);
	expect(body.textContent).toBe(text);
	expect(body.querySelector('em mark')?.textContent).toBe('world');
	expect(Array.from(body.querySelectorAll('mark')).map(mark => mark.textContent).join('')).toBe(text.slice(3, 15));
});
it('keeps adjacent highlights separate and identifies every formatted fragment', () => {
	const { document } = parseHTML('<html><body><p>Hello <em>world</em>!</p></body></html>');
	const body = document.body as unknown as HTMLElement;
	paintHighlights(body, [{ start: 0, end: 6, text: 'Hello ' }, { start: 6, end: 12, text: 'world!' }]);
	const marks = Array.from(body.querySelectorAll('mark'));
	expect(marks.map(mark => [mark.dataset.highlightStart, mark.dataset.highlightEnd])).toEqual([['0', '6'], ['6', '12'], ['6', '12']]);
	expect(marks.map(mark => mark.getAttribute('tabindex'))).toEqual(['0', '0', '-1']);
});

it('resizes either endpoint, clamps crossing handles, and keeps emoji intact', () => {
	const text = 'One 😀 two';
	const span = { start: 4, end: 6, text: '😀' };
	expect(resizeHighlight(text, span, 'start', 20)).toEqual(span);
	expect(resizeHighlight(text, span, 'end', 0)).toEqual(span);
	expect(resizeHighlight(text, span, 'start', 0)).toEqual({ start: 0, end: 6, text: 'One 😀' });
	expect(resizeHighlight(text, span, 'end', 50)).toEqual({ start: 4, end: 10, text: '😀 two' });
});

import { expect, it } from 'vitest';
import { highlightedAt, highlightsMatch, highlightTerms, matchesReadingQuery, readingTerms, searchableQuery, searchWords, titleMatches, wordTerm } from './search-terms';

it('searches only from three characters, counting letters rather than code units or edge spaces', () => {
	expect(searchableQuery('ja')).toBe('');
	expect(searchableQuery('  ja  ')).toBe('');
	expect(searchableQuery('😀😀')).toBe('');
	expect(searchableQuery('jav')).toBe('jav');
	expect(searchableQuery('go at')).toBe('go at');
});

it('splits titles into lowercase words without accents or punctuation', () => {
	expect(searchWords('Café — Crème brûlée, 2nd édition! Café')).toEqual(['cafe', 'creme', 'brulee', '2nd', 'edition']);
	expect(searchWords('日本語の記事 and C++')).toEqual(['日本語の記事', 'and', 'c']);
});

it('stores each title word once, by its first three letters or whole when shorter, with tags and the link', () => {
	expect(readingTerms({ title: 'Go at scale scaling', tags: ['Systems'], source_url: 'https://www.youtube.com/watch?v=abcdefghijk&t=3#x' })).toEqual([
		'w:go', 'w:at', 'p:sca', 't:systems', 'u:https://www.youtube.com/watch?v=abcdefghijk',
	]);
	expect(readingTerms({ title: 'Vault note', tags: [], source_url: '' })).toEqual(['p:vau', 'p:not']);
	expect(wordTerm('javascript')).toBe('p:jav');
	expect(wordTerm('ja')).toBe('w:ja');
});

it('matches when every query word starts a title word', () => {
	expect(titleMatches('Learning JavaScript deeply', 'javas learn')).toBe(true);
	expect(titleMatches('Learning JavaScript deeply', 'script')).toBe(false);
	expect(titleMatches('Anything', '  ')).toBe(true);
});

it('indexes highlight text, notes, the title and tags only for highlighted notes', () => {
	const note = { title: 'Go deep', tags: ['Ideas'], saved_at: '2026-01-01T00:00:00.000Z' };
	expect(highlightTerms({ ...note, highlights: [] })).toEqual([]);
	expect(highlightTerms({ ...note, highlights: [{ start: 0, end: 14, text: 'Patient habits', note: 'Revisit' }] })).toEqual([
		'w:go', 'p:dee', 'p:pat', 'p:hab', 'p:rev', 't:ideas',
	]);
});

it('dates a note by its newest highlight, falling back to the saved date', () => {
	const saved_at = '2026-01-01T00:00:00.000Z';
	expect(highlightedAt({ saved_at })).toBeNull();
	expect(highlightedAt({ saved_at, highlights: [{ start: 0, end: 1, text: 'a' }] })).toBe(saved_at);
	expect(highlightedAt({ saved_at, highlights: [
		{ start: 0, end: 1, text: 'a', createdAt: '2026-03-01T00:00:00.000Z' }, { start: 2, end: 3, text: 'b', createdAt: '2026-02-01T00:00:00.000Z' },
	] })).toBe('2026-03-01T00:00:00.000Z');
});

it('matches a highlight search when every query word starts a title, highlight or note word', () => {
	const item = { title: 'Essays', highlights: [{ start: 0, end: 14, text: 'Patient habits', note: 'Revisit later' }] };
	expect(highlightsMatch(item, 'habi revis')).toBe(true);
	expect(highlightsMatch(item, 'essay patient')).toBe(true);
	expect(highlightsMatch(item, 'abits')).toBe(false);
});

it('matches a library search by title, or highlights in the Highlights tab, and by tag', () => {
	const item = { title: 'Systems at scale', tags: ['Café'], highlights: [{ start: 0, end: 20, text: 'Queues absorb bursts' }] };
	expect(matchesReadingQuery(item, { query: 'sys sca', highlights: false })).toBe(true);
	expect(matchesReadingQuery(item, { query: 'queues', highlights: false })).toBe(false);
	expect(matchesReadingQuery(item, { query: 'queues', highlights: true })).toBe(true);
	// Tags compare case-insensitively after Unicode normalization.
	expect(matchesReadingQuery(item, { query: '', tag: 'CAFE\u0301', highlights: false })).toBe(true);
	expect(matchesReadingQuery(item, { query: 'systems', tag: 'other', highlights: false })).toBe(false);
	// An empty or blank query, and no tag, match every note.
	for (const query of ['', '   ']) expect(matchesReadingQuery(item, { query, tag: null, highlights: true })).toBe(true);
});

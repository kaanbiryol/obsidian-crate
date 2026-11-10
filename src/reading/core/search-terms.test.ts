import { expect, it } from 'vitest';
import { readingTerms, searchableQuery, searchWords, titleMatches, wordTerm } from './search-terms';

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

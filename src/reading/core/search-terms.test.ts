import { expect, it } from 'vitest';
import { readingTerms, searchWords, titleMatches } from './search-terms';

it('splits titles into lowercase words without accents or punctuation', () => {
	expect(searchWords('Café — Crème brûlée, 2nd édition! Café')).toEqual(['cafe', 'creme', 'brulee', '2nd', 'edition']);
	expect(searchWords('日本語の記事 and C++')).toEqual(['日本語の記事', 'and', 'c']);
});

it('stores title words, their first three letters, tags and the link identity', () => {
	expect(readingTerms({ title: 'Go at scale', tags: ['Systems'], source_url: 'https://www.youtube.com/watch?v=abcdefghijk&t=3#x' })).toEqual([
		'w:go', 'w:at', 'w:scale', 'p:sca', 't:systems', 'u:https://www.youtube.com/watch?v=abcdefghijk',
	]);
	expect(readingTerms({ title: 'Vault note', tags: [], source_url: '' })).toEqual(['w:vault', 'p:vau', 'w:note', 'p:not']);
});

it('matches when every query word starts a title word', () => {
	expect(titleMatches('Learning JavaScript deeply', 'javas learn')).toBe(true);
	expect(titleMatches('Learning JavaScript deeply', 'script')).toBe(false);
	expect(titleMatches('Anything', '  ')).toBe(true);
});

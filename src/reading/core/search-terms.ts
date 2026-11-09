import { readingUrlIdentity, type ReadingMetadata } from './model';

/**
 * Title search terms, shared by the Worker (unencrypted vaults), devices (encrypted vaults) and
 * the web app's offline search. A term is `w:<word>` for a title word, `p:<first 3 letters>`
 * for a word of 3 or more letters, `t:<tag>` for a tag and `u:<link identity>`. Encrypted
 * vaults store each term as a keyed hash; see `src/encryption/reading-search.ts`.
 */
const MAX_SEARCH_WORD = 32;
export const SEARCH_PREFIX = 3;
const MAX_TITLE_WORDS = 64;
export const MAX_QUERY_WORDS = 8;

/** Lowercase words with diacritics removed, split on anything that is not a letter or digit. */
export function searchWords(text: string, limit = MAX_TITLE_WORDS): string[] {
	const words = text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US').split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean).map(word => [...word].slice(0, MAX_SEARCH_WORD).join(''));
	return [...new Set(words)].slice(0, limit);
}

export const normalizedTag = (tag: string) => tag.normalize('NFKC').toLocaleLowerCase('en-US');

/** Every term stored for a note, without duplicates. */
export function readingTerms(item: Pick<ReadingMetadata, 'title' | 'tags' | 'source_url'>): string[] {
	const terms = new Set<string>();
	for (const word of searchWords(item.title)) {
		terms.add(`w:${word}`);
		if ([...word].length >= SEARCH_PREFIX) terms.add(`p:${[...word].slice(0, SEARCH_PREFIX).join('')}`);
	}
	for (const tag of item.tags) terms.add(`t:${normalizedTag(tag)}`);
	if (item.source_url) { try { terms.add(`u:${readingUrlIdentity(item.source_url)}`); } catch { /* Not a link. */ } }
	return [...terms];
}

/** Whether a title matches a query: every query word is a prefix of a title word. */
export function titleMatches(title: string, query: string): boolean {
	const words = searchWords(title), wanted = searchWords(query, MAX_QUERY_WORDS);
	return wanted.every(part => words.some(word => word.startsWith(part)));
}

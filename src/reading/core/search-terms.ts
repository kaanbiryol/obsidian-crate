import { readingUrlIdentity, type ReadingMetadata } from './model';

/**
 * Title search terms, shared by the Worker (unencrypted vaults), devices (encrypted vaults) and
 * the web app's offline search. Each title word is stored once: `p:<first 3 letters>` for a word
 * of 3 or more letters, `w:<word>` for a shorter one. A tag is `t:<tag>` and the link
 * `u:<link identity>`. A query word maps to the same term, so a term match is a candidate the
 * title then confirms. Encrypted vaults store each term as a keyed hash; see
 * `src/encryption/reading-search.ts`.
 */
const MAX_SEARCH_WORD = 32;
const SEARCH_PREFIX = 3;
const MAX_TITLE_WORDS = 64;
export const MAX_QUERY_WORDS = 8;

/** Lowercase words with diacritics removed, split on anything that is not a letter or digit. */
export function searchWords(text: string, limit = MAX_TITLE_WORDS): string[] {
	const words = text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US').split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean).map(word => [...word].slice(0, MAX_SEARCH_WORD).join(''));
	return [...new Set(words)].slice(0, limit);
}

export const normalizedTag = (tag: string) => tag.normalize('NFKC').toLocaleLowerCase('en-US');

/** The term a title or query word matches by. */
export const wordTerm = (word: string) => [...word].length >= SEARCH_PREFIX ? `p:${[...word].slice(0, SEARCH_PREFIX).join('')}` : `w:${word}`;

/** Every term stored for a note, without duplicates. */
export function readingTerms(item: Pick<ReadingMetadata, 'title' | 'tags' | 'source_url'>): string[] {
	const terms = new Set<string>();
	for (const word of searchWords(item.title)) terms.add(wordTerm(word));
	for (const tag of item.tags) terms.add(`t:${normalizedTag(tag)}`);
	if (item.source_url) { try { terms.add(`u:${readingUrlIdentity(item.source_url)}`); } catch { /* Not a link. */ } }
	return [...terms];
}

// A note holds at most 16,000 highlighted characters and 48 KB of highlight JSON.
const MAX_HIGHLIGHT_WORDS = 8000;
export const MAX_HIGHLIGHT_TERMS = 3000;

/** The words a highlight search matches for a note: its title and each highlight's text and note. */
export function highlightSearchWords(item: Pick<ReadingMetadata, 'title' | 'highlights'>): string[] {
	return searchWords([item.title, ...(item.highlights ?? []).flatMap(highlight => [highlight.text, highlight.note ?? ''])].join(' '), MAX_HIGHLIGHT_WORDS);
}

/** The terms a highlight search matches a highlighted note by, in the same format as
 * `readingTerms`: each word of `highlightSearchWords` and each tag. Empty without highlights. */
export function highlightTerms(item: Pick<ReadingMetadata, 'title' | 'tags' | 'highlights'>): string[] {
	if (!item.highlights?.length) return [];
	const terms = new Set(highlightSearchWords(item).map(wordTerm));
	for (const tag of item.tags) terms.add(`t:${normalizedTag(tag)}`);
	return [...terms].slice(0, MAX_HIGHLIGHT_TERMS);
}

/** When a note was last highlighted, which orders the Highlights tab: its newest highlight's
 * date, or its saved date for a highlight without one. Null without highlights. */
export function highlightedAt(item: Pick<ReadingMetadata, 'saved_at' | 'highlights'>): string | null {
	const highlights = item.highlights ?? [];
	if (!highlights.length) return null;
	return highlights.map(highlight => highlight.createdAt ?? item.saved_at).reduce((latest, date) => date.localeCompare(latest) > 0 ? date : latest);
}

/** The shortest query the web app searches its server library with: one prefix term. */
const MIN_SEARCH_LENGTH = SEARCH_PREFIX;

/** The query itself, or nothing while it is shorter than `MIN_SEARCH_LENGTH`. */
export const searchableQuery = (query: string) => [...query.trim()].length >= MIN_SEARCH_LENGTH ? query : '';

/** Whether a title matches a query: every query word is a prefix of a title word. */
export function titleMatches(title: string, query: string): boolean {
	return wordsMatch(searchWords(title), query);
}

/** Whether a note matches a highlight search: every query word starts a word of its title or highlights. */
export const highlightsMatch = (item: Pick<ReadingMetadata, 'title' | 'highlights'>, query: string) => wordsMatch(highlightSearchWords(item), query);

function wordsMatch(words: string[], query: string): boolean {
	return searchWords(query, MAX_QUERY_WORDS).every(part => words.some(word => word.startsWith(part)));
}

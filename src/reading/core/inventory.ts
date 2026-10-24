import { readingUrlIdentity, type ReadingItem } from './model';

/** Split items into those with a unique Reading ID and those sharing one.
 * Both lists keep input order; neither copy of a duplicate is chosen. */
export function filterUniqueReadingIds<T extends Pick<ReadingItem, 'crate_reading_id'>>(items: readonly T[]): { unique: T[]; duplicates: T[] } {
	const counts = new Map<string, number>();
	for (const item of items) counts.set(item.crate_reading_id, (counts.get(item.crate_reading_id) ?? 0) + 1);
	const unique: T[] = [], duplicates: T[] = [];
	for (const item of items) (counts.get(item.crate_reading_id) === 1 ? unique : duplicates).push(item);
	return { unique, duplicates };
}

export type SavedReadingLink<T> = { kind: 'none' } | { kind: 'one'; item: T } | { kind: 'many' };

/** Find the item that already saves `url`. Several matches are ambiguous and
 * callers must not pick one. */
export function findSavedReadingLink<T extends Pick<ReadingItem, 'source_url'>>(items: readonly T[], url: string): SavedReadingLink<T> {
	const identity = readingUrlIdentity(url);
	const matches = items.filter(item => item.source_url && readingUrlIdentity(item.source_url) === identity);
	if (matches.length > 1) return { kind: 'many' };
	return matches[0] ? { kind: 'one', item: matches[0] } : { kind: 'none' };
}

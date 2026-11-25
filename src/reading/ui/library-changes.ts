import type { ReadingItem } from '../core/model';
import { inReadingSection, type ReadingSection } from '../core/reading-presentation';
import { highlightedAt } from '../core/search-terms';

/** What changed between two library revisions: the notes listed now, and the paths that no
 * longer list a note (deleted, moved away, hidden as a duplicate). */
export interface ReadingLibraryChanges { from: string; to: string; items: ReadingItem[]; removed: string[] }

/** The key the server sorts a section by, newest first. */
const sortKey = (section: ReadingSection, item: ReadingItem) => section === 'highlights' ? highlightedAt(item) ?? '' : item.saved_at;

/** A section's loaded rows with `changes` applied: a changed note leaves its old place and goes
 * where it now sorts. When the section is not `complete` (more pages follow), a note older than
 * the last loaded row waits for the page that lists it. Returns `items` itself when nothing changed. */
export function applyReadingChanges(section: ReadingSection, items: ReadingItem[], complete: boolean, changes: Pick<ReadingLibraryChanges, 'items' | 'removed'>): ReadingItem[] {
	const paths = new Set([...changes.removed, ...changes.items.map(item => item.path)]), ids = new Set(changes.items.map(item => item.crate_reading_id));
	const next = items.filter(item => !paths.has(item.path) && !ids.has(item.crate_reading_id));
	// The next page starts after the last row loaded, whatever happened to it.
	const boundary = complete || !items.length ? null : sortKey(section, items.at(-1)!);
	for (const item of changes.items) {
		const key = sortKey(section, item);
		if (!inReadingSection(section, item) || boundary !== null && key < boundary) continue;
		const index = next.findIndex(other => sortKey(section, other) < key);
		next.splice(index < 0 ? next.length : index, 0, item);
	}
	return next.length === items.length && next.every((item, index) => item === items[index]) ? items : next;
}

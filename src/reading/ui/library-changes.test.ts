import { expect, it } from 'vitest';
import type { ReadingItem } from '../core/model';
import { applyReadingChanges } from './library-changes';

const article = (n: number, changes: Partial<ReadingItem> = {}): ReadingItem => ({ crate_reading_version: 1, crate_reading_id: `12345678-1234-4123-8123-${String(n).padStart(12, '0')}`,
	title: `Article ${n}`, path: `Reading/article-${n}.md`, source_url: 'https://example.test/article',
	saved_at: `2026-10-${String(30 - n).padStart(2, '0')}T12:00:00Z`, reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'ready', ...changes });
const titles = (items: ReadingItem[]) => items.map(item => item.title);
const loaded = [1, 2, 3, 4].map(n => article(n));

it('updates a changed note in place and keeps the rows that did not change', () => {
	const next = applyReadingChanges('inbox', loaded, false, { items: [article(2, { title: 'Renamed' })], removed: [] });
	expect(titles(next)).toEqual(['Article 1', 'Renamed', 'Article 3', 'Article 4']);
	expect(next[0]).toBe(loaded[0]);
});

it('removes a note that left the section, was deleted or moved, and adds a moved one where it sorts', () => {
	const next = applyReadingChanges('inbox', loaded, false, { items: [article(1, { reading_status: 'archived' }), article(3, { path: 'Reading/Later/3.md' })], removed: ['Reading/article-4.md', 'Reading/article-3.md'] });
	expect(next.map(item => item.path)).toEqual(['Reading/article-2.md', 'Reading/Later/3.md']);
});

it('places a new note only inside the loaded range unless the section is complete', () => {
	const older = article(9), newer = article(0);
	expect(titles(applyReadingChanges('inbox', loaded, false, { items: [newer, older], removed: [] }))).toEqual(['Article 0', 'Article 1', 'Article 2', 'Article 3', 'Article 4']);
	expect(titles(applyReadingChanges('inbox', loaded, true, { items: [older], removed: [] })).at(-1)).toBe('Article 9');
});

it('sorts Highlights by when each note was last highlighted and returns the same list when nothing applies', () => {
	const highlighted = (n: number, at: string) => article(n, { highlights: [{ id: `h${n}`, text: 'x', start: 0, end: 1, createdAt: at }] });
	const list = [highlighted(1, '2026-11-03T00:00:00Z'), highlighted(2, '2026-11-01T00:00:00Z')];
	expect(titles(applyReadingChanges('highlights', list, true, { items: [highlighted(9, '2026-11-02T00:00:00Z')], removed: [] }))).toEqual(['Article 1', 'Article 9', 'Article 2']);
	expect(applyReadingChanges('highlights', list, true, { items: [article(5)], removed: [] })).toBe(list);
});

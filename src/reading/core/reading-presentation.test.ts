import { describe, expect, it } from 'vitest';
import type { ReadingItem } from './model';
import { filterReadingItems, groupReadingItems, filterReadingHighlights, settledHighlights } from './reading-presentation';

const item = (id: string, savedAt: string, overrides: Partial<ReadingItem> = {}): ReadingItem => ({
	crate_reading_id: id, crate_reading_version: 1, title: 'A thoughtful essay', source_url: 'https://journal.example.com/read',
	saved_at: savedAt, reading_status: 'inbox', favorite: false, tags: ['design'], extraction_status: 'ready', path: `Reading/${id}.md`, ...overrides,
});

describe('reading navigation', () => {
	it('finds highlighted passages and annotations across archived and active articles', () => {
		const items = [item('active', '2026-09-19T12:00:00Z'), item('saved', '2026-09-21T12:00:00Z', { reading_status: 'archived', highlights: [{ start: 0, end: 6, text: 'Wisdom', note: 'Revisit this idea' }] })];
		expect(filterReadingItems(items, 'highlights', 'wisdom', null).map(item => item.crate_reading_id)).toEqual(['saved']);
		expect(filterReadingItems(items, 'highlights', 'REVISIT', 'design')).toHaveLength(1);
		expect(filterReadingItems(items, 'highlights', 'missing', null)).toEqual([]);
	});
	it('keeps archived favorites searchable without changing the source collection', () => {
		const items = [item('older', '2026-09-19T12:00:00Z'), item('saved', '2026-09-21T12:00:00Z', { reading_status: 'archived', favorite: true })];
		expect(filterReadingItems(items, 'inbox', '', null).map(i => i.crate_reading_id)).toEqual(['older']);
		expect(filterReadingItems(items, 'favorites', 'DESIGN', 'design').map(i => i.crate_reading_id)).toEqual(['saved']);
		expect(filterReadingItems(items, 'archived', 'journal.example', null)).toHaveLength(1);
		expect(filterReadingItems(items, 'favorites', '', 'other')).toEqual([]);
		expect(items.map(i => i.crate_reading_id)).toEqual(['older', 'saved']);
	});
	it('groups yesterday across month and year boundaries using local calendar dates', () => {
		const now = new Date(2026, 0, 1, 12);
		const items = [item('today', new Date(2026, 0, 1, 8).toISOString()), item('yesterday', new Date(2025, 11, 31, 8).toISOString()), item('earlier', new Date(2025, 10, 20, 8).toISOString())];
		const groups = groupReadingItems(items, now);
		expect(groups.map(group => group.items.map(i => i.crate_reading_id))).toEqual([['today'], ['yesterday'], ['earlier']]);
		expect(groups[0]?.label).toBe('Today');
		expect(groups[1]?.label).toBe('Yesterday');
		expect(groups[2]?.label).toContain('2025');
	});
});


describe('highlight feed', () => {
	it('interleaves articles newest first, dating unrecorded highlights by their article, and searches notes', () => {
		const first = item('first', '2026-09-01', { highlights: [
			{ start: 0, end: 3, text: 'Old', createdAt: '2026-09-20', note: 'Keep' },
			{ start: 4, end: 7, text: 'New', createdAt: '2026-09-23', note: 'Keep' },
		] });
		const second = item('second', '2026-09-21', { highlights: [
			{ start: 0, end: 6, text: 'Middle', createdAt: '2026-09-22' },
			{ start: 7, end: 12, text: 'Typed' },
		] });
		expect(filterReadingHighlights([first, second], '').map(entry => entry.highlight.text)).toEqual(['New', 'Middle', 'Typed', 'Old']);
		expect(filterReadingHighlights([first, second], 'keep').map(entry => entry.highlight.text)).toEqual(['New', 'Old']);
		expect(filterReadingHighlights([], '')).toEqual([]);
	});
});

describe('highlights of a server library', () => {
	const note: ReadingItem = { crate_reading_version: 1, crate_reading_id: '12345678-1234-4123-8123-123456789abc', title: 'Notes', path: 'Reading/notes.md',
		source_url: 'https://example.test/notes', saved_at: '2026-10-01T12:00:00Z', reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'ready',
		highlights: [{ start: 0, end: 10, text: 'The quick brown fox at the café', createdAt: '2026-10-03T12:00:00Z' }, { start: 20, end: 30, text: 'A lazy dog', createdAt: '2026-10-02T12:00:00Z' }] };
	const texts = (query: string) => filterReadingHighlights([note], query, true).map(entry => entry.highlight.text);

	it('shows the highlights a word search matched, as the server matched the note', () => {
		// Before: the rows needed the whole query as one substring, so these showed nothing.
		expect(texts('quick fox')).toEqual(['The quick brown fox at the café']);
		expect(texts('cafe')).toEqual(['The quick brown fox at the café']);
		// Words in different highlights show all of the note's highlights.
		expect(texts('fox dog')).toEqual(['The quick brown fox at the café', 'A lazy dog']);
		expect(texts('notes lazy')).toEqual(['A lazy dog']);
	});
});

describe('highlights feed across server pages', () => {
	const note = (id: string, dates: string[]): ReadingItem => ({ crate_reading_version: 1, crate_reading_id: `12345678-1234-4123-8123-${id.padStart(12, '0')}`, title: id,
		path: `Reading/${id}.md`, source_url: 'https://example.test/', saved_at: '2026-01-01T00:00:00Z', reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'ready',
		highlights: dates.map((createdAt, index) => ({ start: index, end: index + 1, text: `${id} ${createdAt.slice(0, 10)}`, createdAt })) });
	const rows = (items: ReadingItem[], loaded = items) => settledHighlights(filterReadingHighlights(items, '', true), loaded).map(entry => entry.highlight.text);

	it('holds back rows a later page could still place above', () => {
		// Pages are ordered by each note's newest highlight: A (Nov 15), then B (Nov 1) on page two.
		const a = note('1', ['2026-11-15T00:00:00Z', '2026-01-01T00:00:00Z']), b = note('2', ['2026-11-01T00:00:00Z']);
		// Before: A's January row showed at the end of page one, then B's November row was inserted above it.
		const first = rows([a]);
		expect(first).toEqual(['1 2026-11-15']);
		const both = rows([a, b]);
		expect(both.slice(0, first.length)).toEqual(first);
		expect(both).toEqual(['1 2026-11-15', '2 2026-11-01']);
	});
});

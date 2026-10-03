import { describe, expect, it } from 'vitest';
import type { ReadingItem } from '../core/model';
import { filterReadingItems, groupReadingItems, filterReadingHighlights, groupReadingHighlights } from './reading-presentation';

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


describe('highlight article groups', () => {
	it('keeps an article together in latest-highlight order, including filtered notes', () => {
		const first = item('first', '2026-09-01', { highlights: [
			{ start: 0, end: 3, text: 'Old', createdAt: '2026-09-20', note: 'Keep' },
			{ start: 4, end: 7, text: 'New', createdAt: '2026-09-23', note: 'Keep' },
		] });
		const second = item('second', '2026-09-02', { highlights: [{ start: 0, end: 6, text: 'Middle', createdAt: '2026-09-22' }] });
		const entries = filterReadingHighlights([first, second], '', '');
		const groups = groupReadingHighlights(entries);
		expect(groups.map(group => group.item.crate_reading_id)).toEqual(['first', 'second']);
		expect(groups[0]?.entries.map(entry => entry.highlight.text)).toEqual(['New', 'Old']);
		expect(groupReadingHighlights(filterReadingHighlights([first, second], 'keep', ''))).toHaveLength(1);
		expect(groupReadingHighlights(filterReadingHighlights([first, second], '', 'second'))[0]?.item).toBe(second);
		expect(groupReadingHighlights([])).toEqual([]);
		expect(entries.map(entry => entry.highlight.text)).toEqual(['New', 'Middle', 'Old']);
	});
});

import { describe, expect, it } from 'vitest';
import type { ReadingItem } from '../core/model';
import { filterReadingItems, groupReadingItems } from './reading-presentation';

const item = (id: string, savedAt: string, overrides: Partial<ReadingItem> = {}): ReadingItem => ({
	crate_reading_id: id, crate_reading_version: 1, title: 'A thoughtful essay', source_url: 'https://journal.example.com/read',
	saved_at: savedAt, reading_status: 'inbox', favorite: false, tags: ['design'], extraction_status: 'ready', path: `Reading/${id}.md`, ...overrides,
});

describe('reading navigation', () => {
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

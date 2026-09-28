import { describe, expect, it } from 'vitest';
import { DOCK_TABS, dockDestinationIndex, normalizeDockTabs } from './dock-preferences';

describe('dock destinations', () => {
	it('keeps existing selections first and fills older short lists to four unique tabs', () => {
		for (const { id } of DOCK_TABS) {
			const tabs = normalizeDockTabs([id]);
			expect(tabs[0]).toBe(id);
			expect(tabs).toHaveLength(4);
			expect(new Set(tabs).size).toBe(4);
		}
	});
	it('selects the exact Reading destination without reassigning another slot', () => {
		const tabs = normalizeDockTabs(['highlights', 'archive', 'favorites', 'reading']);
		expect(dockDestinationIndex(tabs, 'reading', 'highlights')).toBe(0);
		expect(dockDestinationIndex(tabs, 'reading', 'archived')).toBe(1);
		expect(dockDestinationIndex(tabs, 'reading', 'favorites')).toBe(2);
		expect(dockDestinationIndex(tabs, 'reading', 'inbox')).toBe(3);
		expect(dockDestinationIndex(['reading', 'inbox'], 'reading', 'favorites')).toBe(-1);
		expect(dockDestinationIndex(['favorites', 'inbox'], 'reading', 'inbox')).toBe(-1);
	});
	it('keeps both date views under the Reminders tab', () => {
		for (const tab of ['today', 'upcoming']) {
			expect(dockDestinationIndex(['inbox', 'today', 'reading', 'browse'], 'reminders', tab)).toBe(1);
			expect(dockDestinationIndex(['inbox', 'favorites', 'reading', 'browse'], 'reminders', tab)).toBe(-1);
		}
	});
	it('migrates old date-view slots to Reminders and fills duplicate slots', () => {
		expect(normalizeDockTabs(['archive', 'upcoming', 'favorites', 'highlights'])).toEqual(['archive', 'today', 'favorites', 'highlights']);
		expect(normalizeDockTabs(['upcoming', 'today-view', 'inbox', 'reading'])).toEqual(['today', 'inbox', 'reading', 'browse']);
		expect(normalizeDockTabs(['today-view', 'today', 'upcoming', 'reading'])).toEqual(['today', 'reading', 'inbox', 'browse']);
	});
});

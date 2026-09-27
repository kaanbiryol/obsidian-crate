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
	it('selects pinned Reading destinations before falling back to the Reading picker', () => {
		const tabs = normalizeDockTabs(['highlights', 'archive', 'favorites', 'reading']);
		expect(dockDestinationIndex(tabs, 'reading', 'highlights')).toBe(0);
		expect(dockDestinationIndex(tabs, 'reading', 'archived')).toBe(1);
		expect(dockDestinationIndex(tabs, 'reading', 'favorites')).toBe(2);
		expect(dockDestinationIndex(tabs, 'reading', 'inbox')).toBe(3);
		expect(dockDestinationIndex(['reading', 'inbox'], 'reading', 'favorites')).toBe(0);
		expect(dockDestinationIndex(['favorites', 'inbox'], 'reading', 'inbox')).toBe(-1);
	});
	it('selects Today directly without treating it as an Upcoming fallback', () => {
		expect(dockDestinationIndex(['today', 'today-view', 'upcoming', 'inbox'], 'reminders', 'today')).toBe(1);
		expect(dockDestinationIndex(['today-view', 'inbox', 'browse', 'reading'], 'reminders', 'upcoming')).toBe(-1);
	});
	it('selects Upcoming separately when pinned, otherwise Reminders', () => {
		expect(dockDestinationIndex(['today', 'upcoming'], 'reminders', 'upcoming')).toBe(1);
		expect(dockDestinationIndex(['today'], 'reminders', 'upcoming')).toBe(0);
		expect(dockDestinationIndex(['upcoming'], 'reminders', 'today')).toBe(-1);
	});
});

import { Script } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { PWA_OPENING_DOCK_INIT_JS } from './opening-dock';

it.each([
	['', null, 'today', '1'],
	['', '{"defaultScreen":"inbox"}', 'inbox', '0'],
	['?tab=upcoming', null, 'upcoming', '1'],
	['', '{"defaultScreen":"upcoming"}', 'upcoming', '1'],
	['?tab=inbox', '{"defaultScreen":"browse"}', 'inbox', '0'],
	['?project=Work&tab=inbox', null, 'browse', '2'],
	['?section=reading&tab=today', null, 'reading', '3'],
	['?tab=invalid', 'invalid', 'today', '1'],
	['?tab=today', 'unavailable', 'today', '1'],
])('selects the dock before the cached shell paints: %s / %s', (search, stored, tab, index) => {
	const root = { dataset: {} as Record<string, string>, style: { setProperty: vi.fn() } };
	new Script(PWA_OPENING_DOCK_INIT_JS).runInNewContext({
		document: { documentElement: root }, location: { search }, URLSearchParams,
		localStorage: { getItem: () => { if (stored === 'unavailable') throw new Error('denied'); return stored; } },
	});
	expect(root.dataset.pwaOpeningTab).toBe(tab);
	expect(root.style.setProperty).toHaveBeenCalledWith('--pwa-opening-dock-index', index);
	expect(root.style.setProperty).toHaveBeenCalledWith('--pwa-opening-dock-indicator', index === '-1' ? '0' : '1');
});

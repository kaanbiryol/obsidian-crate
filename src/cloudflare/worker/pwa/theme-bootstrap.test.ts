import { Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { PWA_THEME_BOOTSTRAP_JS } from './theme-bootstrap';
import { PWA_UPDATE_TRANSITION_KEY } from '../../../pwa/update-transition';

const now = 1_000_000;

function bootstrap(marker: string | null, storageUnavailable = false) {
	const root = { dataset: {} as Record<string, string>, style: { setProperty: vi.fn(), background: '', colorScheme: '' } };
	const lightTheme = { media: '(prefers-color-scheme: light)' };
	const themeColor = { setAttribute: vi.fn() };
	const storage = {
		getItem: vi.fn(() => {
			if (storageUnavailable) throw new Error('Storage unavailable');
			return marker;
		}),
		removeItem: vi.fn(),
	};
	new Script(PWA_THEME_BOOTSTRAP_JS).runInNewContext({
		Date: { now: () => now },
		document: { documentElement: root, getElementById: (id: string) => id === 'pwa-light-theme' ? lightTheme : themeColor },
		window: { matchMedia: () => ({ matches: true }) },
		localStorage: { getItem: () => 'dark' },
		sessionStorage: storage,
	});
	return { root, lightTheme, storage };
}

describe('PWA update startup', () => {
	it('restores the update curtain with the saved theme before app startup', () => {
		const { root, lightTheme, storage } = bootstrap(String(now - 100));
		expect(root.dataset).toEqual({ pwaColorScheme: 'dark', pwaUpdating: 'restore' });
		expect(root.style.background).toBe('#0b0b0d');
		expect(lightTheme.media).toBe('not all');
		expect(storage.removeItem).toHaveBeenCalledWith(PWA_UPDATE_TRANSITION_KEY);
	});

	it.each([null, 'invalid', '0', String(now - 60_000), String(now + 1)])(
		'ignores and consumes an absent or stale marker (%s)', marker => {
			const { root, storage } = bootstrap(marker);
			expect(root.dataset.pwaUpdating).toBeUndefined();
			expect(storage.removeItem).toHaveBeenCalledWith(PWA_UPDATE_TRANSITION_KEY);
		},
	);

	it('still applies the theme when session storage is unavailable', () => {
		const { root } = bootstrap(null, true);
		expect(root.dataset).toEqual({ pwaColorScheme: 'dark' });
	});
});

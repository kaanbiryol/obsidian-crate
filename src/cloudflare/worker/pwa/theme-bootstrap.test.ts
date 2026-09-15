import { Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { PWA_THEME_BOOTSTRAP_JS } from './theme-bootstrap';
import { PWA_UPDATE_TRANSITION_KEY } from '../../../pwa/update-transition';

const now = 1_000_000;

interface BootstrapDevice {
	userAgent: string;
	standalone: boolean;
	maxTouchPoints: number;
	modernWebKit: boolean;
	displayStandalone: boolean;
}

function bootstrap(marker: string | null, storageUnavailable = false, device: Partial<BootstrapDevice> = {}) {
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
		navigator: { userAgent: '', maxTouchPoints: 0, ...device },
		window: {
			matchMedia: (query: string) => ({ matches: query.includes('display-mode') ? Boolean(device.displayStandalone) : true }),
			CSS: { supports: () => Boolean(device.modernWebKit) },
		},
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

describe('installed iOS scroll-edge clearance', () => {
	const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
	const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
	it.each([
		{ name: 'iOS 27', userAgent: iphone.replace('18_7', '27_0'), expected: true },
		{ name: 'later iOS', userAgent: iphone.replace('18_7', '28_0'), expected: true },
		{ name: 'frozen OS with Safari 27', userAgent: `${iphone} Version/27.0`, expected: true },
		{ name: 'frozen OS without Safari version', userAgent: iphone, modernWebKit: true, expected: true },
		{ name: 'older frozen OS', userAgent: iphone, expected: false },
		{ name: 'Safari 26 with experimental features', userAgent: `${iphone} Version/26.6`, modernWebKit: true, expected: false },
		{ name: 'explicit iOS 26', userAgent: iphone.replace('18_7', '26_0'), expected: false },
		{ name: 'iPad desktop UA', userAgent: ipad, maxTouchPoints: 5, modernWebKit: true, expected: true },
		{ name: 'desktop Safari 27', userAgent: `${ipad} Version/27.0`, expected: false },
		{ name: 'Android', userAgent: 'Mozilla/5.0 (Linux; Android 27) Chrome/150.0', modernWebKit: true, expected: false },
		{ name: 'ordinary iOS browser tab', userAgent: `${iphone} Version/27.0`, standalone: false, expected: false },
		{ name: 'standalone media query', userAgent: `${iphone} Version/27.0`, standalone: false, displayStandalone: true, expected: true },
	])('$name', ({ expected, ...device }) => {
		const { root } = bootstrap(null, false, { standalone: true, ...device });
		expect('pwaIosScrollEdge' in root.dataset).toBe(expected);
		expect(root.dataset.pwaColorScheme).toBe('dark');
	});
});

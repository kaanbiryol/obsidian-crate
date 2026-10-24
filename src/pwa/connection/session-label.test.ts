import { describe, expect, it } from 'vitest';
import { detectWebSessionName } from './session-label';

const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';

describe('web session labels', () => {
	it('distinguishes Safari and Home Screen sessions on the same iPhone', () => {
		const device = { userAgent: `${iphone} Version/26.0 Mobile/15E148 Safari/604.1`, maxTouchPoints: 5 };
		expect(detectWebSessionName(device, false)).toBe('iPhone · Safari');
		expect(detectWebSessionName(device, true)).toBe('iPhone · Home Screen app');
	});

	it.each([
		['CriOS/140.0 Mobile/15E148 Safari/604.1', 'Chrome'],
		['FxiOS/140.0 Mobile/15E148 Safari/604.1', 'Firefox'],
		['CriOS/140.0 Mobile/15E148 Safari/604.1 EdgiOS/140.0', 'Edge'],
		['OPiOS/90.0 Mobile/15E148 Safari/604.1', 'Opera'],
		['Mobile/15E148', 'Browser'],
	])('does not mislabel overlapping browser tokens as Safari: %s', (suffix, browser) => {
		expect(detectWebSessionName({ userAgent: `${iphone} ${suffix}`, maxTouchPoints: 5 }, false)).toBe(`iPhone · ${browser}`);
	});

	it('recognizes an iPad using its desktop user agent', () => {
		const device = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/26.0 Safari/605.1.15', maxTouchPoints: 5 };
		expect(detectWebSessionName(device, false)).toBe('iPad · Safari');
		expect(detectWebSessionName(device, true)).toBe('iPad · Home Screen app');
	});

	it('uses installed-app wording on desktop', () => {
		const device = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36 Edg/140.0', maxTouchPoints: 0 };
		expect(detectWebSessionName(device, false)).toBe('Windows · Edge');
		expect(detectWebSessionName(device, true)).toBe('Windows · Installed app');
	});
});

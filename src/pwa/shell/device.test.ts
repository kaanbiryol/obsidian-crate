import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectDeviceName, isIosOrIpados, isStandaloneApp } from './device';

function device(userAgent: string, maxTouchPoints = 0): Pick<Navigator, 'maxTouchPoints' | 'userAgent'> {
	return { userAgent, maxTouchPoints };
}

describe('PWA installed-app detection', () => {
	afterEach(() => vi.unstubAllGlobals());
	it.each([
		[true, undefined, true],
		[false, true, true],
		[false, false, false],
		[false, undefined, false],
	])('detects display mode %s and Safari standalone %s', (matches, standalone, installed) => {
		vi.stubGlobal('window', { matchMedia: (query: string) => ({ matches: query === '(display-mode: standalone)' && matches }) });
		vi.stubGlobal('navigator', { standalone });
		expect(isStandaloneApp()).toBe(installed);
	});
});

describe('PWA device detection', () => {
	it('recognizes iPhones and classic iPad user agents', () => {
		expect(isIosOrIpados(device('Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X'))).toBe(true);
		expect(isIosOrIpados(device('Mozilla/5.0 (iPad; CPU OS 18_4 like Mac OS X'))).toBe(true);
	});

	it('recognizes iPads that request the desktop website', () => {
		const desktopIpad = device('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15', 5);
		expect(isIosOrIpados(desktopIpad)).toBe(true);
		expect(detectDeviceName(desktopIpad)).toBe('iPad');
	});

	it('does not mistake a non-touch Mac for an iPad', () => {
		const mac = device('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15');
		expect(isIosOrIpados(mac)).toBe(false);
		expect(detectDeviceName(mac)).toBe('Mac');
	});
});

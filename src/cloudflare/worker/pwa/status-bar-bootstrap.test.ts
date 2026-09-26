import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { PWA_STATUS_BAR_INIT_JS } from './status-bar-bootstrap';

const iphone = (os: string, browser = '') => `Mozilla/5.0 (iPhone; CPU iPhone OS ${os} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ${browser} Mobile/15E148`;
const desktop = (device: string) => `Mozilla/5.0 (${device}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15`;

function bootstrap(userAgent: string, { standalone = true, displayMode = false, platform = 'iPhone', maxTouchPoints = 5 } = {}) {
	const root = { dataset: {} as Record<string, string> };
	const meta = { content: 'black-translucent', setAttribute(_name: string, value: string) { this.content = value; } };
	new Script(PWA_STATUS_BAR_INIT_JS).runInNewContext({
		navigator: { userAgent, standalone, platform, maxTouchPoints },
		window: { matchMedia: () => ({ matches: displayMode }) },
		document: { documentElement: root, querySelector: () => meta },
	});
	return { mode: meta.content, enabled: root.dataset.pwaIos27Standalone === 'true' };
}

describe('iOS 27 status-bar startup', () => {
	it.each([
		iphone('27_0'), // Home Screen UA without a Safari version.
		iphone('27_1_2'),
		iphone('18_6_2', 'Version/27.0 Safari/604.1'), // Frozen Safari OS token.
		'Mozilla/5.0 (iPad; CPU OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
	])('enables the workaround for an identified iOS 27 installation: %s', ua => {
		expect(bootstrap(ua)).toEqual({ mode: 'default', enabled: true });
	});

	it('recognizes an iPad using the desktop Safari UA', () => {
		expect(bootstrap(desktop('Macintosh; Intel Mac OS X 10_15_7'), { platform: 'MacIntel' }))
			.toEqual({ mode: 'default', enabled: true });
	});

	it.each([
		iphone('18_6_2'), // Ambiguous frozen UA: do not guess a version.
		iphone('18_6_2', 'Version/26.0 Safari/604.1'),
		iphone('26_5'),
		iphone('28_0'),
		iphone('18_6_2', 'Version/28.0 Safari/604.1'),
		iphone('18_6_2', 'FxiOS/27.0 Version/27.0'),
		desktop('Linux; Android 27'),
	])('preserves other or unknown versions: %s', ua => {
		expect(bootstrap(ua, { platform: 'Linux armv8l' })).toEqual({ mode: 'black-translucent', enabled: false });
	});

	it('leaves macOS Safari 27 unchanged', () => {
		expect(bootstrap(desktop('Macintosh; Intel Mac OS X 10_15_7'), { platform: 'MacIntel', maxTouchPoints: 0 }))
			.toEqual({ mode: 'black-translucent', enabled: false });
	});

	it('sets installation metadata in Safari without changing the browser layout', () => {
		expect(bootstrap(iphone('18_6_2', 'Version/27.0 Safari/604.1'), { standalone: false }))
			.toEqual({ mode: 'default', enabled: false });
	});

	it('also accepts the standard standalone display mode', () => {
		expect(bootstrap(iphone('27_0'), { standalone: false, displayMode: true }))
			.toEqual({ mode: 'default', enabled: true });
	});
});

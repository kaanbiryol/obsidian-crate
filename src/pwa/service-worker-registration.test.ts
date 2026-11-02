import { afterEach, describe, expect, it, vi } from 'vitest';
import { PWA_ASSET_VERSION } from '@/pwa/shell/version';
import { registerPwaServiceWorker } from './service-worker-registration';

afterEach(() => vi.restoreAllMocks());

describe('service worker startup registration', () => {
	afterEach(() => vi.unstubAllGlobals());
	it('reuses the active shell while a newer worker downloads', async () => {
		const existing = {
			active: { scriptURL: `https://crate.test/notifications/sw.js?v=${PWA_ASSET_VERSION}` },
			installing: { scriptURL: 'https://crate.test/notifications/sw.js?v=new' },
		};
		const register = vi.fn();
		vi.stubGlobal('navigator', { serviceWorker: { getRegistration: vi.fn().mockResolvedValue(existing), register } });
		await expect(registerPwaServiceWorker()).resolves.toBe(existing);
		expect(register).not.toHaveBeenCalled();
	});
	it('registers offline support when there is no active worker', async () => {
		const register = vi.fn().mockResolvedValue({});
		vi.stubGlobal('navigator', { serviceWorker: { getRegistration: vi.fn().mockResolvedValue(undefined), register } });
		await registerPwaServiceWorker();
		expect(register).toHaveBeenCalledWith(`/notifications/sw.js?v=${PWA_ASSET_VERSION}`, { scope: '/notifications' });
	});
	it.each(['active', 'waiting', 'installing'])('does not replace a newer %s worker from an older document', async slot => {
		const existing = { [slot]: { scriptURL: 'https://crate.test/notifications/sw.js?v=new', state: slot === 'active' ? 'activated' : slot === 'waiting' ? 'installed' : 'installing' } };
		const register = vi.fn();
		vi.stubGlobal('navigator', { serviceWorker: { getRegistration: vi.fn().mockResolvedValue(existing), register } });
		await expect(registerPwaServiceWorker()).resolves.toBe(existing);
		expect(register).not.toHaveBeenCalled();
	});
});

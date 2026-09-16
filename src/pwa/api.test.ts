import { afterEach, describe, expect, it, vi } from 'vitest';
import { PWA_ASSET_VERSION } from '@/cloudflare/worker/pwa-version';
import { getPwaPushManager, registerPwaServiceWorker } from './api';

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
});

describe('getPwaPushManager', () => {
	it('uses the window-level manager exposed by declarative Web Push', async () => {
		const windowPushManager = {} as PushManager;
		const registerServiceWorker = vi.fn<() => Promise<ServiceWorkerRegistration | null>>();

		await expect(getPwaPushManager({ windowPushManager, registerServiceWorker }))
			.resolves.toBe(windowPushManager);
		expect(registerServiceWorker).not.toHaveBeenCalled();
	});

	it('falls back to the service worker registration manager', async () => {
		const registrationPushManager = {} as PushManager;
		const registerServiceWorker = vi.fn(async () => ({
			pushManager: registrationPushManager,
		}) as ServiceWorkerRegistration);

		await expect(getPwaPushManager({ windowPushManager: null, registerServiceWorker }))
			.resolves.toBe(registrationPushManager);
	});

	it('returns null when neither push manager is available', async () => {
		await expect(getPwaPushManager({
			windowPushManager: null,
			registerServiceWorker: async () => null,
		})).resolves.toBeNull();
	});
});

import { describe, expect, it, vi } from 'vitest';
import { getPwaPushManager } from './api';

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

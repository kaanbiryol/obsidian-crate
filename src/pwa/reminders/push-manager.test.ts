import { afterEach, describe, expect, it, vi } from 'vitest';
import * as encryptionSession from './encryption-session';
import { getPwaPushManager } from './push-manager';

afterEach(() => vi.restoreAllMocks());

describe('getPwaPushManager', () => {
	it('uses the window-level manager exposed by declarative Web Push', async () => {
		vi.spyOn(encryptionSession, 'reminderEncryptionSnapshot').mockReturnValue({ status: 'unencrypted' });
		const windowPushManager = {} as PushManager;
		const registerServiceWorker = vi.fn<() => Promise<ServiceWorkerRegistration | null>>();

		await expect(getPwaPushManager({ windowPushManager, registerServiceWorker }))
			.resolves.toBe(windowPushManager);
		expect(registerServiceWorker).not.toHaveBeenCalled();
	});
	it.each(['checking', 'ready', 'locked'] as const)('keeps push on the decrypting service worker while encryption is %s', async status => {
		vi.spyOn(encryptionSession, 'reminderEncryptionSnapshot').mockReturnValue(status === 'ready' ? { status, folderPath: 'Reminders' }
			: status === 'locked' ? { status, message: 'Unlock keys', converting: false, setupRequired: false, unavailable: false, offlineCopy: false } : { status });
		const pushManager = {} as PushManager;
		await expect(getPwaPushManager({ windowPushManager: {} as PushManager,
			registerServiceWorker: async () => ({ pushManager }) as ServiceWorkerRegistration })).resolves.toBe(pushManager);
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

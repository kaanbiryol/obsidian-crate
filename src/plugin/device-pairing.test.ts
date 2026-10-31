import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	requests: [] as Array<{ path: string; body: string }>,
	exchange: vi.fn<() => Promise<unknown>>(),
	capabilities: ['device-pairing-v1'],
	configure: vi.fn(async () => ({ success: true })),
	encryption: vi.fn(async (): Promise<{ mode: string } | null> => null),
	confirm: vi.fn(async () => true),
	keysModal: vi.fn(),
	notices: [] as string[],
	featureChoice: vi.fn(async () => {}),
}));

vi.mock('obsidian', () => ({ Notice: class { constructor(message: string) { mocks.notices.push(message); } } }));
vi.mock('./cloudflare-connection', () => ({ configureCloudflareAuthorizedDevice: mocks.configure }));
vi.mock('./feature-settings', () => ({ offerFeatureChoice: mocks.featureChoice }));
vi.mock('./deviceInfo', () => ({ getCurrentDeviceName: () => 'iPhone', getCurrentPlatformCode: () => 'ios' }));
vi.mock('../cloudflare/device-token', () => ({ generateSecureToken: () => 'phone-token', hashToken: async () => 'phone-token-hash' }));
vi.mock('../sync/encryption/server-encryption', () => ({ readServerEncryption: mocks.encryption }));
vi.mock('../ui/confirmation-modal', () => ({ openConfirmationModal: mocks.confirm }));
vi.mock('../ui/settings/device-key-pairing-modal', () => ({ DeviceKeyPairingModal: class { open = mocks.keysModal; } }));
vi.mock('../sync/worker-api/http', () => {
	class HttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }
	return {
		HttpError,
		WorkerApiHttpClient: class {
			setAbortSignal() {}
			async getServerInfo() { return { capabilities: mocks.capabilities }; }
			async requestJson(path: string, options: { body: string }) { mocks.requests.push({ path, body: options.body }); return mocks.exchange(); }
		},
	};
});

import { handleDevicePairingLink, redeemDevicePairing } from './device-pairing';

const origin = 'https://crate-0123456789abcdef.example.workers.dev';
const deployment = { deploymentId: '0123456789abcdef', accountId: 'a'.repeat(32), accountName: 'Personal', workerName: 'crate-0123456789abcdef',
	d1DatabaseName: 'crate-0123456789abcdef', d1DatabaseId: '01234567-89ab-cdef-0123-456789abcdef', r2BucketName: 'crate-0123456789abcdef',
	workersSubdomain: 'example', lastDeployedVersion: '0.9.0', lastDeployedFingerprint: null };
const target = { origin, code: 'c'.repeat(64) };

function createPlugin(configured = false) {
	return {
		app: {},
		settings: { deviceId: 'phone-device' } as Record<string, unknown>,
		syncRuntime: { isConfigured: vi.fn(() => configured) },
		writeSettings: vi.fn(async function (this: { settings: Record<string, unknown> }, update: Record<string, unknown>) { Object.assign(plugin.settings, update); }),
		refreshSettingsTab: vi.fn(),
	};
}
let plugin = createPlugin();

beforeEach(() => {
	plugin = createPlugin();
	mocks.requests.length = 0; mocks.notices.length = 0;
	mocks.capabilities = ['device-pairing-v1'];
	mocks.exchange.mockReset().mockResolvedValue({ tokenId: 'token-id', deployment });
	mocks.configure.mockClear(); mocks.encryption.mockReset().mockResolvedValue(null); mocks.confirm.mockClear(); mocks.keysModal.mockClear();
});

describe('redeemDevicePairing', () => {
	it('saves the server identity before connecting with a locally generated token', async () => {
		await expect(redeemDevicePairing(plugin as never, target)).resolves.toEqual({ encrypted: false, synced: true });
		expect(JSON.parse(mocks.requests[0]!.body)).toEqual({ code: target.code, tokenHash: 'phone-token-hash', deviceId: 'phone-device', deviceName: 'iPhone', platform: 'ios' });
		expect(mocks.requests[0]!.body).not.toContain('phone-token"');
		expect(plugin.settings.cloudflareDeployment).toMatchObject({ workerName: deployment.workerName, accountId: deployment.accountId });
		expect(plugin.writeSettings.mock.invocationCallOrder[0]).toBeLessThan(mocks.configure.mock.invocationCallOrder[0]!);
		expect(mocks.configure).toHaveBeenCalledWith(plugin, origin, 'phone-token');
	});

	it('retries a lost response with the same token hash', async () => {
		mocks.exchange.mockRejectedValueOnce(new Error('Network unavailable'));
		await redeemDevicePairing(plugin as never, target);
		expect(mocks.requests.map(request => request.body)).toEqual([mocks.requests[0]!.body, mocks.requests[0]!.body]);
	});

	it.each([
		['an already connected vault', () => { plugin = createPlugin(true); }, 'already connected'],
		['a server without pairing', () => { mocks.capabilities = []; }, 'Update the server'],
		['a different server identity', () => { mocks.exchange.mockResolvedValue({ tokenId: 'id', deployment: { ...deployment, workerName: 'crate-fedcba9876543210' } }); }, 'unexpected identity'],
	])('refuses %s without saving a connection', async (_label, arrange, message) => {
		arrange();
		await expect(redeemDevicePairing(plugin as never, target)).rejects.toThrow(message);
		expect(plugin.settings.cloudflareDeployment).toBeUndefined();
		expect(mocks.configure).not.toHaveBeenCalled();
	});

	it('opens key approval for an encrypted vault after confirmation', async () => {
		mocks.encryption.mockResolvedValue({ mode: 'active' });
		await handleDevicePairingLink(plugin as never, `${origin}/notifications/pair#${target.code}`);
		expect(mocks.confirm).toHaveBeenCalledOnce();
		expect(mocks.keysModal).toHaveBeenCalledOnce();
	});

	it('offers the feature choice after connecting an unencrypted vault', async () => {
		mocks.featureChoice.mockClear();
		await handleDevicePairingLink(plugin as never, `${origin}/notifications/pair#${target.code}`);
		expect(mocks.featureChoice).toHaveBeenCalledWith(plugin);
		expect(mocks.keysModal).not.toHaveBeenCalled();
	});

	it('does nothing when the user cancels or the link is invalid', async () => {
		mocks.confirm.mockResolvedValueOnce(false);
		await handleDevicePairingLink(plugin as never, `${origin}/notifications/pair#${target.code}`);
		await handleDevicePairingLink(plugin as never, `${origin}/notifications/pair#short`);
		expect(mocks.requests).toEqual([]);
		expect(mocks.notices).toEqual([expect.stringContaining('invalid')]);
	});
});

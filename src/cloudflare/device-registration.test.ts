import { describe, expect, it, vi } from 'vitest';
import { registerCloudflareAuthorizedDevice } from './device-registration';

const device = {
	tokenHash: 'token-hash',
	deviceId: 'device-id',
	deviceName: 'MacBook',
	platform: 'macos',
};

describe('registerCloudflareAuthorizedDevice', () => {
	it('rotates the credential for a device that is reconnecting after a local reset', async () => {
		const queryD1 = vi.fn()
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ results: [{ id: 'existing-token-id' }] }])
			.mockResolvedValueOnce([]);

		await registerCloudflareAuthorizedDevice({
			api: { queryD1 } as never,
			accountId: 'account-id',
			databaseId: 'database-id',
			device,
		});

		expect(queryD1).toHaveBeenCalledTimes(3);
		expect(queryD1.mock.calls[2]?.[3]).toEqual([
			'token-hash',
			'MacBook',
			'macos',
			'existing-token-id',
		]);
	});

	it('registers a fresh device when Cloudflare has no matching device ID', async () => {
		const queryD1 = vi.fn()
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ results: [] }])
			.mockResolvedValueOnce([]);

		await registerCloudflareAuthorizedDevice({
			api: { queryD1 } as never,
			accountId: 'account-id',
			databaseId: 'database-id',
			device,
		});

		expect(queryD1).toHaveBeenCalledTimes(3);
		expect(queryD1.mock.calls[2]?.[3]).toEqual([
			expect.stringMatching(/^[a-f0-9]{32}$/),
			'token-hash',
			'device-id',
			'MacBook',
			'macos',
		]);
	});
});

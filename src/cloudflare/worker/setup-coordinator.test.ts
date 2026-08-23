import { describe, expect, it } from 'vitest';
import { SetupCoordinator } from './setup-coordinator';

describe('SetupCoordinator compatibility export', () => {
	it('rejects legacy device enrollment now that Cloudflare owns authorization', async () => {
		const response = await new SetupCoordinator().fetch();

		expect(response.status).toBe(410);
		await expect(response.json()).resolves.toEqual({
			error: 'Device setup requires Cloudflare authorization',
		});
	});
});

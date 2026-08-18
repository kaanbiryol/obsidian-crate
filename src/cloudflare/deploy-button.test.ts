import { describe, expect, it } from 'vitest';
import {
	buildCloudflareDeployUrl,
	CRATE_CLOUDFLARE_DEPLOY_URL,
	CRATE_REPOSITORY_URL,
} from './deploy-button';

describe('Cloudflare deploy button', () => {
	it('points Cloudflare at the public Crate repository', () => {
		const url = new URL(CRATE_CLOUDFLARE_DEPLOY_URL);

		expect(url.origin).toBe('https://deploy.workers.cloudflare.com');
		expect(url.searchParams.get('url')).toBe(CRATE_REPOSITORY_URL);
	});

	it('supports a repository override for forks', () => {
		expect(new URL(buildCloudflareDeployUrl('https://github.com/example/crate-fork'))
			.searchParams.get('url')).toBe('https://github.com/example/crate-fork');
	});
});

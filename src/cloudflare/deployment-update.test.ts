import { describe, expect, it } from 'vitest';
import type { CloudflareDeploymentMetadata } from './deployment-types';
import { isCloudflareServerUpdateAvailable } from './deployment-update';

function createDeployment(overrides: Partial<CloudflareDeploymentMetadata> = {}): CloudflareDeploymentMetadata {
	return {
		deploymentId: '0123456789abcdef',
		accountId: null,
		accountName: null,
		workerName: 'crate-0123456789abcdef',
		d1DatabaseName: 'crate-0123456789abcdef',
		d1DatabaseId: null,
		r2BucketName: 'crate-0123456789abcdef',
		workersSubdomain: 'example-account',
		lastDeployedVersion: '0.1.0',
		lastDeployedFingerprint: 'a'.repeat(64),
		...overrides,
	};
}

const embedded = {
	version: '0.1.0',
	fingerprint: 'b'.repeat(64),
};

describe('isCloudflareServerUpdateAvailable', () => {
	it('detects changed Worker, PWA, or schema artifacts within the same plugin version', () => {
		expect(isCloudflareServerUpdateAvailable(createDeployment(), embedded)).toBe(true);
	});

	it('ignores a newer plugin release when its deployable artifacts are unchanged', () => {
		expect(isCloudflareServerUpdateAvailable(createDeployment({
			lastDeployedFingerprint: embedded.fingerprint,
		}), {
			...embedded,
			version: '0.2.0',
		})).toBe(false);
	});

	it('reports an exact deployed artifact as up to date', () => {
		expect(isCloudflareServerUpdateAvailable(createDeployment({
			lastDeployedFingerprint: embedded.fingerprint,
		}), embedded)).toBe(false);
	});

	it('does not offer to downgrade a server deployed by a newer plugin', () => {
		expect(isCloudflareServerUpdateAvailable(createDeployment({
			lastDeployedVersion: '0.2.0',
		}), embedded)).toBe(false);
	});

	it('does not offer to downgrade a newer legacy server without a fingerprint', () => {
		expect(isCloudflareServerUpdateAvailable(createDeployment({
			lastDeployedVersion: '0.2.0',
			lastDeployedFingerprint: null,
		}), embedded)).toBe(false);
	});

	it('offers a one-time update when older metadata has no artifact fingerprint', () => {
		expect(isCloudflareServerUpdateAvailable(createDeployment({
			lastDeployedFingerprint: null,
		}), embedded)).toBe(true);
	});
});

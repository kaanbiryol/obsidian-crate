import { describe, expect, it } from 'vitest';
import { stableJson } from '../../platform/stable-json';
import {
	assertDeploymentCanStart, assertRequestCurrent, assertSavedAuthorizationCanStart, assertSavedRequestCurrent, assertSavedServer, assertSavedTarget,
} from './preconditions';
import type { CloudflareDeploymentMetadata, DeploymentIntent, DeploymentRequest } from './types';

const saved = (overrides: Partial<CloudflareDeploymentMetadata> = {}): CloudflareDeploymentMetadata => ({
	deploymentId: '0123456789abcdef', accountId: 'a'.repeat(32), accountName: 'Personal', workerName: 'crate-0123456789abcdef',
	d1DatabaseName: 'crate-0123456789abcdef', d1DatabaseId: 'database', r2BucketName: 'crate-0123456789abcdef',
	workersSubdomain: 'example', lastDeployedVersion: '0.1.0', lastDeployedFingerprint: null, ...overrides,
});
const deletion = { id: 'b'.repeat(32), phase: 'removing-worker' as const, databaseId: 'database', bucketCreatedAt: null, workerCreatedAt: null, helperName: `crate-delete-${'b'.repeat(32)}` };
const request = (intent: DeploymentIntent, metadata = saved(), original: CloudflareDeploymentMetadata | null = metadata): DeploymentRequest =>
	({ intent, metadata, discoverExisting: false, originalMetadata: stableJson(original) });

describe('deployment preconditions', () => {
	it('requires a complete saved server before deletion or reconnection starts', () => {
		expect(() => assertDeploymentCanStart(null, 'connect')).not.toThrow();
		expect(() => assertDeploymentCanStart(saved({ d1DatabaseId: null }), 'delete')).toThrow('Connect to a Crate server before resetting');
		expect(() => assertDeploymentCanStart(saved({ accountId: null }), 'reconnect')).toThrow('Connect a Cloudflare server first.');
		expect(() => assertDeploymentCanStart(saved({ deletion }), 'update')).toThrow('Resume server deletion before connecting or updating.');
		expect(() => assertDeploymentCanStart(saved({ deletion }), 'delete')).not.toThrow();
	});

	it('refuses a request whose saved server changed during authorization', () => {
		expect(() => assertRequestCurrent(saved(), request('delete'))).not.toThrow();
		expect(() => assertRequestCurrent(saved({ workersSubdomain: 'other' }), request('delete'))).toThrow('Confirm the deletion again.');
		expect(() => assertRequestCurrent(saved(), request('switch', saved(), null))).toThrow('during authorization. Start again.');
		expect(() => assertRequestCurrent(saved({ d1DatabaseId: 'other' }), request('reconnect'))).toThrow('Server settings changed. Start again.');
		expect(() => assertRequestCurrent(saved({ deletion }), request('connect'))).toThrow('Resume server deletion before connecting');
	});

	it('requires the saved server before using the saved login', () => {
		expect(() => assertSavedAuthorizationCanStart(saved(), 'update')).not.toThrow();
		expect(() => assertSavedAuthorizationCanStart(undefined, 'update')).toThrow('Connect a Cloudflare server first.');
		expect(() => assertSavedAuthorizationCanStart(saved({ d1DatabaseId: null }), 'delete')).toThrow('Connect a Cloudflare server first.');
		expect(() => assertSavedAuthorizationCanStart(saved({ deletion }), 'update')).toThrow('Resume server deletion before continuing.');
		expect(() => assertSavedRequestCurrent(saved({ workersSubdomain: 'other' }), request('update'))).toThrow('Confirm the operation again.');
		expect(() => assertSavedRequestCurrent(saved(), request('update'))).not.toThrow();
	});

	it('accepts a saved server without its database only for account operations', () => {
		const missing = { missing: 'Select the server first.' };
		expect(() => assertSavedServer(saved({ d1DatabaseId: null }), missing)).toThrow(missing.missing);
		expect(() => assertSavedServer(saved({ deletion }), missing)).toThrow(missing.missing);
		expect(() => assertSavedServer(saved({ d1DatabaseId: null }), { ...missing, accountOnly: true })).not.toThrow();
		expect(() => assertSavedServer(saved({ accountId: null }), { ...missing, accountOnly: true })).toThrow(missing.missing);
	});

	it.each([['update', 'Start the update again.'], ['delete', 'Start the deletion again.'], ['reconnect', 'Start again.']] as const)(
		'names the %s operation when its saved server changed', (intent, next) => {
			expect(() => assertSavedTarget(saved(), saved(), intent)).not.toThrow();
			expect(() => assertSavedTarget(saved({ r2BucketName: 'other' }), saved(), intent)).toThrow(`Server settings changed. ${next}`);
			expect(() => assertSavedTarget(null, saved(), intent)).toThrow(`Server settings changed. ${next}`);
		});

	it('requires the same pending deletion it started with', () => {
		expect(() => assertSavedTarget(saved({ deletion }), saved({ deletion }), 'delete')).not.toThrow();
		expect(() => assertSavedTarget(saved({ deletion: { ...deletion, id: 'c'.repeat(32) } }), saved({ deletion }), 'delete')).toThrow('Start the deletion again.');
	});
});

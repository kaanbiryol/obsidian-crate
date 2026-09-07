import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type CrateSettings } from '../plugin/settings';
import type { HttpTransport } from './http';
import type { DiscoveredCloudflareDeployment } from './deployment-discovery';
import {
	CLOUDFLARE_OAUTH_REDIRECT_URL,
	CLOUDFLARE_OAUTH_SCOPES,
} from './oauth-config';

const deleteCrateServer = vi.hoisted(() => vi.fn(async (_input: unknown) => {}));
vi.mock('./server-delete', () => ({ deleteCrateServer }));

const resetCrateServer = vi.hoisted(() => vi.fn(async (_input: unknown) => {}));
vi.mock('./server-reset', () => ({ resetCrateServer }));

const apiMocks = vi.hoisted(() => ({
	accounts: [{ id: '0123456789abcdef0123456789abcdef', name: 'Personal' }],
	constructedWithTokens: [] as string[],
	workers: [] as Array<{ id: string; modified_on?: string }>,
	workerSettings: new Map<string, unknown>(),
	queryD1: vi.fn(async (..._args: unknown[]) => [{ results: [] }]),
}));

const provisionCloudflareDeployment = vi.hoisted(() => vi.fn(async (input: {
	metadata: { lastDeployedVersion: string | null };
	onMetadataChanged(): Promise<void>;
}) => {
	input.metadata.lastDeployedVersion = '0.1.0';
	await input.onMetadataChanged();
	return 'https://crate-0123456789abcdef.example.workers.dev';
}));

vi.mock('./cloudflare-api', () => ({
	CloudflareApiClient: class CloudflareApiClient {
		constructor(accessToken: string) {
			apiMocks.constructedWithTokens.push(accessToken);
		}

		async listAuthorizedAccounts() {
			return apiMocks.accounts;
		}

		async listWorkers() {
			return apiMocks.workers;
		}

		async getWorkersSubdomain() { return 'example'; }

		async getWorkerSettings(_accountId: string, workerName: string) {
			return apiMocks.workerSettings.get(workerName) ?? { bindings: [] };
		}

		async queryD1(...args: unknown[]) {
			return apiMocks.queryD1(...args);
		}
	},
}));

vi.mock('./provisioner', () => ({ provisionCloudflareDeployment }));

import { CloudflareDeploymentService } from './deployment-service';

const CLIENT_ID = '0123456789abcdef0123456789abcdef';

function createHarness() {
	const settings: CrateSettings = { ...DEFAULT_SETTINGS };
	const persisted: string[] = [];
	const settingsOwner = {
		settings,
		writeSettings: vi.fn(async (update: Partial<CrateSettings>) => {
			Object.assign(settingsOwner.settings, update);
			persisted.push(JSON.stringify(settingsOwner.settings));
		}),
	};
	const opened: string[] = [];
	const transportCalls: Array<{ url: string; body: string | ArrayBuffer | undefined }> = [];
	const transportImplementation: HttpTransport = async (url, request) => {
		transportCalls.push({ url, body: request.body });
		if (url.endsWith('/oauth2/token')) {
			return { status: 200, text: JSON.stringify({ access_token: 'temporary-access-token' }) };
		}
		if (url.endsWith('/oauth2/revoke')) return { status: 200, text: '{}' };
		throw new Error(`Unexpected transport request: ${url}`);
	};
	const transport = vi.fn(transportImplementation);
	const loadArtifacts = vi.fn(async () => ({
		version: '0.1.0',
		fingerprint: 'f'.repeat(64),
		workerBundle: 'export default {};',
		workerBundleSha256: 'worker-hash',
		d1Schema: 'CREATE TABLE IF NOT EXISTS example (id TEXT);',
		d1SchemaSha256: 'schema-hash',
	}));
	const beforeServerReset = vi.fn(async () => {});
	const service = new CloudflareDeploymentService({
		clientId: CLIENT_ID,
		settingsOwner,
		transport,
		loadArtifacts,
		openExternal: url => opened.push(url),
		selectDeployment: vi.fn(async (deployments: DiscoveredCloudflareDeployment[]) => deployments[0] ?? null),
		beforeServerReset,
		now: () => 1_000,
	});
	return { service, settings, settingsOwner, persisted, opened, transportCalls, transport, loadArtifacts, beforeServerReset };
}

function firstOpenedUrl(opened: string[]): URL {
	const url = opened[0];
	if (!url) throw new Error('Expected Cloudflare authorization URL to open');
	return new URL(url);
}

beforeEach(() => {
	apiMocks.accounts = [{ id: '0123456789abcdef0123456789abcdef', name: 'Personal' }];
	apiMocks.constructedWithTokens.length = 0;
	apiMocks.workers = [];
	apiMocks.workerSettings.clear();
	apiMocks.queryD1.mockReset();
	apiMocks.queryD1.mockResolvedValue([{ results: [] }]);
	provisionCloudflareDeployment.mockClear();
	resetCrateServer.mockReset();
	deleteCrateServer.mockReset();
});

describe('CloudflareDeploymentService', () => {
	it('opens Cloudflare authorization with PKCE S256 and minimum scopes', async () => {
		const harness = createHarness();
		await harness.service.startDeployment();

		const authorizationUrl = firstOpenedUrl(harness.opened);
		expect(authorizationUrl.origin + authorizationUrl.pathname).toBe('https://dash.cloudflare.com/oauth2/auth');
		expect(authorizationUrl.searchParams.get('response_type')).toBe('code');
		expect(authorizationUrl.searchParams.get('client_id')).toBe(CLIENT_ID);
		expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(CLOUDFLARE_OAUTH_REDIRECT_URL);
		expect(authorizationUrl.searchParams.get('scope')).toBe(CLOUDFLARE_OAUTH_SCOPES.join(' '));
		expect(authorizationUrl.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
		expect(authorizationUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(harness.settings.cloudflareDeployment).toBeNull();
	});

	it('rejects a mismatched state before exchanging the authorization code', async () => {
		const harness = createHarness();
		await harness.service.startDeployment();

		await expect(harness.service.handleCallback({
			code: 'sensitive-authorization-code',
			state: 'attacker-state',
		})).rejects.toThrow('state did not match');
		expect(harness.transport).not.toHaveBeenCalled();
	});

	it('exchanges, provisions, revokes, and never persists OAuth credentials', async () => {
		const harness = createHarness();
		await harness.service.startDeployment();
		const state = firstOpenedUrl(harness.opened).searchParams.get('state');
		if (!state) throw new Error('Missing OAuth state');

		const result = await harness.service.handleCallback({
			code: 'sensitive-authorization-code',
			state,
		});

		expect(result.workerUrl).toContain('.workers.dev');
		expect(provisionCloudflareDeployment).toHaveBeenCalledTimes(1);
		expect(apiMocks.constructedWithTokens).toEqual(['temporary-access-token']);
		expect(harness.transportCalls.map(call => call.url)).toEqual([
			'https://dash.cloudflare.com/oauth2/token',
			'https://dash.cloudflare.com/oauth2/revoke',
		]);
		expect(harness.opened).toHaveLength(1);

		const tokenRequestBody = harness.transportCalls[0]?.body;
		if (typeof tokenRequestBody !== 'string') throw new Error('Expected form-encoded token request');
		const tokenRequest = new URLSearchParams(tokenRequestBody);
		const verifier = tokenRequest.get('code_verifier');
		if (!verifier) throw new Error('Missing PKCE verifier');
		expect(tokenRequest.get('code')).toBe('sensitive-authorization-code');
		const persistedSettings = harness.persisted.join('\n');
		expect(persistedSettings).not.toContain('sensitive-authorization-code');
		expect(persistedSettings).not.toContain('temporary-access-token');
		expect(persistedSettings).not.toContain(verifier);
	});

	it('does not mutate saved deployment metadata when persistence fails', async () => {
		const harness = createHarness();
		harness.settings.cloudflareDeployment = {
			deploymentId: '0123456789abcdef',
			accountId: null,
			accountName: null,
			workerName: 'crate-0123456789abcdef',
			d1DatabaseName: 'crate-0123456789abcdef',
			d1DatabaseId: null,
			r2BucketName: 'crate-0123456789abcdef',
			workersSubdomain: null,
			lastDeployedVersion: null,
			lastDeployedFingerprint: null,
		};
		harness.settingsOwner.writeSettings.mockRejectedValueOnce(new Error('disk full'));
		await harness.service.startDeployment();
		const state = firstOpenedUrl(harness.opened).searchParams.get('state');
		if (!state) throw new Error('Missing OAuth state');

		await expect(harness.service.handleCallback({ code: 'code', state }))
			.rejects.toThrow('disk full');

		expect(harness.settings.cloudflareDeployment).toEqual(expect.objectContaining({
			accountId: null,
			accountName: null,
			lastDeployedVersion: null,
		}));
	});

	it('discovers an existing Crate deployment and registers this device through Cloudflare', async () => {
		apiMocks.workers = [{
			id: 'crate-fedcba9876543210',
			modified_on: '2026-08-23T09:00:00.000Z',
		}];
		apiMocks.workerSettings.set('crate-fedcba9876543210', {
			annotations: { 'workers/message': 'Crate 9.0.0' },
			bindings: [
				{ type: 'd1', name: 'DB', id: 'existing-database-id' },
				{ type: 'r2_bucket', name: 'BUCKET', bucket_name: 'crate-fedcba9876543210' },
				{ type: 'durable_object_namespace', name: 'REMINDER_ALARMS', class_name: 'ReminderAlarm' },
			],
		});
		const harness = createHarness();
		await harness.service.startDeployment();
		const state = firstOpenedUrl(harness.opened).searchParams.get('state');
		if (!state) throw new Error('Missing OAuth state');

		await harness.service.handleCallback({ code: 'code', state }, {
			tokenHash: 'device-token-hash',
			deviceId: 'device-id',
			deviceName: 'MacBook',
			platform: 'macos',
		});

		expect(harness.settings.cloudflareDeployment).toEqual(expect.objectContaining({
			workerName: 'crate-fedcba9876543210',
			d1DatabaseId: 'existing-database-id',
		}));
		expect(apiMocks.queryD1).toHaveBeenCalledTimes(3);
		expect(apiMocks.queryD1.mock.calls[2]?.[3]).toEqual([
			expect.stringMatching(/^[a-f0-9]{32}$/),
			'device-token-hash',
			'device-id',
			'MacBook',
			'macos',
		]);
		expect(harness.persisted.join('\n')).not.toContain('device-token-hash');
		expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
		expect(harness.settings.cloudflareDeployment?.lastDeployedVersion).toBe('9.0.0');
	});

	it('requires a single newly authorized account and still revokes the token', async () => {
		apiMocks.accounts = [
			{ id: '0123456789abcdef0123456789abcdef', name: 'First' },
			{ id: 'fedcba9876543210fedcba9876543210', name: 'Second' },
		];
		const harness = createHarness();
		await harness.service.startDeployment();
		const state = firstOpenedUrl(harness.opened).searchParams.get('state');
		if (!state) throw new Error('Missing OAuth state');

		await expect(harness.service.handleCallback({ code: 'code', state }))
			.rejects.toThrow('exactly one Cloudflare account');
		expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
		expect(harness.transportCalls.at(-1)?.url).toContain('/oauth2/revoke');
	});
});

function resetHarness() {
	const h = createHarness();
	h.settings.cloudflareDeployment = {
		deploymentId: '0123456789abcdef', accountId: apiMocks.accounts[0]!.id, accountName: 'Personal',
		workerName: 'crate-0123456789abcdef', d1DatabaseName: 'crate-0123456789abcdef',
		d1DatabaseId: '01234567-89ab-cdef-0123-456789abcdef', r2BucketName: 'crate-0123456789abcdef',
		workersSubdomain: 'example', lastDeployedVersion: '0.1.0', lastDeployedFingerprint: null,
	};
	return h;
}
const resetDevice = { tokenHash: 'hash', deviceId: 'device', deviceName: 'Test', platform: 'desktop' };

describe('Cloudflare deployment lifetime', () => {
	it.each(['connect', 'update', 'reset', 'delete'] as const)('revokes a late OAuth token without starting %s after destruction', async intent => {
		const h = intent === 'connect' ? createHarness() : resetHarness();
		let release!: () => void;
		h.transport.mockImplementationOnce(async () => {
			await new Promise<void>(resolve => { release = resolve; });
			return { status: 200, text: JSON.stringify({ access_token: 'late-token' }) };
		});
		await h.service.startDeployment(intent);
		const running = h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }, resetDevice);
		const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(release).toBeTypeOf('function'));
		h.service.destroy();
		release();
		await rejected;
		expect(apiMocks.constructedWithTokens).toEqual([]);
		expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
		expect(resetCrateServer).not.toHaveBeenCalled();
		expect(deleteCrateServer).not.toHaveBeenCalled();
		expect(h.settingsOwner.writeSettings).not.toHaveBeenCalled();
		expect(h.transportCalls).toHaveLength(1);
		expect(h.transportCalls[0]?.url).toContain('/oauth2/revoke');
		expect(h.transportCalls[0]?.body).toContain('late-token');
	});

	it.each(['connect', 'reset', 'delete'] as const)('does not begin %s after artifacts finish loading on a destroyed service', async intent => {
		const h = intent === 'connect' ? createHarness() : resetHarness();
		let release!: () => void;
		const artifacts = await h.loadArtifacts();
		h.loadArtifacts.mockImplementationOnce(async () => {
			await new Promise<void>(resolve => { release = resolve; });
			return artifacts;
		});
		await h.service.startDeployment(intent);
		const running = h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }, resetDevice);
		const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(release).toBeTypeOf('function'));
		const writes = h.persisted.length;
		h.service.destroy();
		release();
		await rejected;
		expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
		expect(resetCrateServer).not.toHaveBeenCalled();
		expect(deleteCrateServer).not.toHaveBeenCalled();
		expect(h.persisted).toHaveLength(writes);
		expect(h.transportCalls.at(-1)?.url).toContain('/oauth2/revoke');
	});

	it('cannot reopen authorization after destruction, including during PKCE generation', async () => {
		const h = createHarness();
		const pending = h.service.startDeployment();
		h.service.destroy();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		await expect(h.service.startDeployment()).rejects.toMatchObject({ name: 'AbortError' });
		expect(h.service.pendingIntent).toBeNull();
		expect(h.opened).toEqual([]);
	});

	it('does not report success when destroyed while revoking the temporary token', async () => {
		const h = createHarness();
		const transport = h.transport.getMockImplementation()!;
		h.transport.mockImplementation(async (url, request) => {
			if (url.endsWith('/oauth2/revoke')) h.service.destroy();
			return transport(url, request);
		});
		await h.service.startDeployment();
		await expect(h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }))
			.rejects.toMatchObject({ name: 'AbortError' });
		expect(h.transportCalls.at(-1)?.url).toContain('/oauth2/revoke');
	});
});

describe('server reset authorization', () => {
	it('requires an existing deployment before opening authorization', async () => {
		const h = createHarness();
		await expect(h.service.startDeployment('reset')).rejects.toThrow('Connect to a Crate server');
		expect(h.opened).toEqual([]);
	});

	it('resets, provisions a fresh database, registers the device, and revokes authorization', async () => {
		const h = resetHarness();
		await h.service.startDeployment('reset');
		expect(h.service.pendingIntent).toBe('reset');
		const params = { code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! };
		await h.service.handleCallback(params, resetDevice);
		expect(resetCrateServer).toHaveBeenCalledOnce();
		expect(resetCrateServer.mock.invocationCallOrder[0]).toBeLessThan(provisionCloudflareDeployment.mock.invocationCallOrder[0]!);
		expect(provisionCloudflareDeployment).toHaveBeenCalledOnce();
		expect(apiMocks.queryD1).toHaveBeenCalled();
		expect(h.transportCalls.some(call => call.url.endsWith('/oauth2/revoke'))).toBe(true);
		expect(h.service.pendingIntent).toBeNull();
		await expect(h.service.handleCallback(params, resetDevice)).rejects.toThrow('No Cloudflare deployment');
		expect(resetCrateServer).toHaveBeenCalledOnce();
	});

	it.each(['missing credential', 'changed settings', 'denied authorization', 'wrong account', 'failed validation'])('does not provision when reset is blocked: %s', async reason => {
		const h = resetHarness();
		await h.service.startDeployment('reset');
		const params: Record<string, string> = { code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! };
		if (reason === 'changed settings') h.settings.cloudflareDeployment!.d1DatabaseId = 'changed';
		if (reason === 'denied authorization') params.error = 'access_denied';
		if (reason === 'wrong account') apiMocks.accounts = [{ id: 'b'.repeat(32), name: 'Other' }];
		if (reason === 'failed validation') resetCrateServer.mockRejectedValue(new Error('Reset blocked'));
		await expect(h.service.handleCallback(params, reason === 'missing credential' ? undefined : resetDevice)).rejects.toThrow();
		expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
		if (reason !== 'failed validation') expect(resetCrateServer).not.toHaveBeenCalled();
	});
	it.each(['connect', 'update'] as const)('blocks %s while a server reset is pending', async intent => {
		const h = resetHarness();
		h.settings.cloudflareDeployment!.reset = { id: 'a'.repeat(32), phase: 'clearing', databaseId: h.settings.cloudflareDeployment!.d1DatabaseId!, bucketCreatedAt: 'date', namespaceId: 'c'.repeat(32) };
		await expect(h.service.startDeployment(intent)).rejects.toThrow('Resume the server reset');
		expect(h.opened).toEqual([]);
	});

	it('does not allow another authorization or callback while reset is running', async () => {
		const h = resetHarness();
		let release!: () => void;
		resetCrateServer.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
		await h.service.startDeployment('reset');
		const params = { code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! };
		const running = h.service.handleCallback(params, resetDevice);
		await vi.waitFor(() => expect(resetCrateServer).toHaveBeenCalledOnce());
		await expect(h.service.startDeployment('reset')).rejects.toThrow('Wait for the current');
		await expect(h.service.handleCallback(params, resetDevice)).rejects.toThrow('already in progress');
		release();
		await running;
	});

	it('deletes without provisioning or registering a device, then clears metadata and revokes access', async () => {
		const h = resetHarness();
		await h.service.startDeployment('delete');
		const result = await h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! });
		expect(result.deleted).toBe(true);
		expect(deleteCrateServer).toHaveBeenCalledOnce();
		expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
		expect(apiMocks.queryD1).not.toHaveBeenCalled();
		expect(h.settings.cloudflareDeployment).toBeNull();
		expect(h.transportCalls.some(call => call.url.endsWith('/oauth2/revoke'))).toBe(true);
	});

	it('keeps metadata and revokes access if deletion fails', async () => {
		const h = resetHarness();
		deleteCrateServer.mockRejectedValue(new Error('Interrupted'));
		await h.service.startDeployment('delete');
		await expect(h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! })).rejects.toThrow('Interrupted');
		expect(h.settings.cloudflareDeployment).not.toBeNull();
		expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
		expect(h.transportCalls.some(call => call.url.endsWith('/oauth2/revoke'))).toBe(true);
	});

	it.each(['connect', 'update', 'reset'] as const)('blocks %s while server deletion is pending', async intent => {
		const h = resetHarness();
		h.settings.cloudflareDeployment!.reset = { id: 'a'.repeat(32), phase: 'clearing', deleteOnly: true, databaseId: h.settings.cloudflareDeployment!.d1DatabaseId!, bucketCreatedAt: 'date', namespaceId: 'c'.repeat(32) };
		await expect(h.service.startDeployment(intent)).rejects.toThrow('Resume server deletion');
	});

});

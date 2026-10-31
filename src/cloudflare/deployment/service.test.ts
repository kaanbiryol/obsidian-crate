import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type CrateSettings } from '../../plugin/settings';
import type { HttpTransport } from '../http';
import type { DiscoveredCloudflareDeployment } from './discovery';
import {
	CLOUDFLARE_OAUTH_REDIRECT_URL,
	CLOUDFLARE_OAUTH_SCOPES,
} from '../oauth/config';

const deleteCrateServer = vi.hoisted(() => vi.fn(async (_input: unknown) => {}));
vi.mock('../server-reset/delete', () => ({ deleteCrateServer }));

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

vi.mock('../cloudflare-api', () => ({
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

import { blockingServerOperation, CloudflareDeploymentService, type CloudflareDeploymentServiceOptions } from './service';
import type { CloudflareDeploymentMetadata, DeploymentIntent } from './types';
import { DesktopOnlyServerChangeError } from './server-changes';

const CLIENT_ID = '0123456789abcdef0123456789abcdef';

function createHarness(onAuthorized?: CloudflareDeploymentServiceOptions['onAuthorized'], options: Partial<CloudflareDeploymentServiceOptions> = {}) {
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
	const beforeServerSwitch = vi.fn(async () => {});
	const selectDeployment = vi.fn(async (deployments: DiscoveredCloudflareDeployment[]): Promise<DiscoveredCloudflareDeployment | 'create' | null> => deployments[0] ?? 'create');
	const service = new CloudflareDeploymentService({
		clientId: CLIENT_ID,
		getVaultName: () => 'Local vault',
		onAuthorized,
		settingsOwner,
		transport,
		loadArtifacts,
		openExternal: url => opened.push(url),
		beforeServerSwitch,
		beforeServerReset,
		now: () => 1_000,
		...options,
	});
	return { service, settings, settingsOwner, persisted, opened, transportCalls, transport, loadArtifacts, beforeServerReset, beforeServerSwitch, selectDeployment };
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
	deleteCrateServer.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('CloudflareDeploymentService', () => {
	it('opens Cloudflare authorization with PKCE S256 and minimum scopes', async () => {
		const harness = createHarness();
		await harness.service.startDeployment();

		const authorizationUrl = firstOpenedUrl(harness.opened);
		expect(authorizationUrl.origin + authorizationUrl.pathname).toBe('https://dash.cloudflare.com/oauth2/auth');
		expect(authorizationUrl.searchParams.get('response_type')).toBe('code');
		expect(authorizationUrl.searchParams.get('client_id')).toBe(CLIENT_ID);
		expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(CLOUDFLARE_OAUTH_REDIRECT_URL);
		expect(authorizationUrl.searchParams.get('scope')).toBe([...CLOUDFLARE_OAUTH_SCOPES, 'offline_access'].join(' '));
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
		}, harness.selectDeployment)).rejects.toThrow('state did not match');
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
		}, harness.selectDeployment);

		expect(result.status).toBe('deployed');
		if (result.status !== 'deployed') throw new Error('Expected a deployed server');
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

		await expect(harness.service.handleCallback({ code: 'code', state }, harness.selectDeployment))
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

		await harness.service.handleCallback({ code: 'code', state }, harness.selectDeployment, {
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

		await expect(harness.service.handleCallback({ code: 'code', state }, harness.selectDeployment))
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
	it('does not reopen authorization cancelled during PKCE generation', async () => {
		const h = createHarness();
		const pending = h.service.startDeployment('create');
		h.service.cancelPendingDeployment();
		await pending;
		expect(h.opened).toEqual([]);
		expect(h.service.pendingIntent).toBeNull();
		await h.service.startDeployment('connect');
		expect(h.opened).toHaveLength(1);
		expect(h.service.pendingIntent).toBe('connect');
	});

	it('keeps the latest authorization when PKCE requests finish out of order', async () => {
		const pending: Array<(value: ArrayBuffer) => void> = [];
		vi.spyOn(crypto.subtle, 'digest').mockImplementation(() => new Promise(resolve => { pending.push(resolve); }));
		const h = createHarness();
		const older = h.service.startDeployment('create');
		const newer = h.service.startDeployment('connect');
		pending[1]!(new ArrayBuffer(32));
		await newer;
		pending[0]!(new ArrayBuffer(32));
		await older;
		expect(h.opened).toHaveLength(1);
		expect(h.service.pendingIntent).toBe('connect');
	});

	it('invalidates a pending PKCE request when saved authorization takes over', async () => {
		let release!: (value: ArrayBuffer) => void;
		vi.spyOn(crypto.subtle, 'digest').mockImplementation(() => new Promise(resolve => { release = resolve; }));
		const h = resetHarness();
		const pending = h.service.startDeployment('delete');
		await h.service.deployWithSavedAuthorization('reconnect', operation => operation({ accessToken: 'saved' }), h.selectDeployment);
		release(new ArrayBuffer(32));
		await pending;
		expect(h.opened).toEqual([]);
		expect(h.service.pendingIntent).toBeNull();
	});

	it.each(['connect', 'update', 'delete'] as const)('revokes a late OAuth token without starting %s after destruction', async intent => {
		const h = intent === 'connect' ? createHarness() : resetHarness();
		let release!: () => void;
		h.transport.mockImplementationOnce(async () => {
			await new Promise<void>(resolve => { release = resolve; });
			return { status: 200, text: JSON.stringify({ access_token: 'late-token' }) };
		});
		await h.service.startDeployment(intent);
		const running = h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }, h.selectDeployment, resetDevice);
		const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(release).toBeTypeOf('function'));
		h.service.destroy();
		release();
		await rejected;
		expect(apiMocks.constructedWithTokens).toEqual([]);
		expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
		expect(deleteCrateServer).not.toHaveBeenCalled();
		expect(h.settingsOwner.writeSettings).not.toHaveBeenCalled();
		expect(h.transportCalls).toHaveLength(1);
		expect(h.transportCalls[0]?.url).toContain('/oauth2/revoke');
		expect(h.transportCalls[0]?.body).toContain('late-token');
	});

	it.each(['connect'] as const)('does not begin %s after artifacts finish loading on a destroyed service', async intent => {
		const h = intent === 'connect' ? createHarness() : resetHarness();
		let release!: () => void;
		const artifacts = await h.loadArtifacts();
		h.loadArtifacts.mockImplementationOnce(async () => {
			await new Promise<void>(resolve => { release = resolve; });
			return artifacts;
		});
		await h.service.startDeployment(intent);
		const running = h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }, h.selectDeployment, resetDevice);
		const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(release).toBeTypeOf('function'));
		const writes = h.persisted.length;
		h.service.destroy();
		release();
		await rejected;
		expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
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
		await expect(h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }, h.selectDeployment))
			.rejects.toMatchObject({ name: 'AbortError' });
		expect(h.transportCalls.at(-1)?.url).toContain('/oauth2/revoke');
	});
});

describe('server deletion authorization', () => {
	it('requires an existing deployment before opening authorization', async () => {
		const h = createHarness();
		await expect(h.service.startDeployment('delete')).rejects.toThrow('Connect to a Crate server');
		expect(h.opened).toEqual([]);
	});

	it('deletes without provisioning or registering a device, then clears metadata and revokes access', async () => {
		const h = resetHarness();
		await h.service.startDeployment('delete');
		const result = await h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }, h.selectDeployment);
		expect(result.status).toBe('deleted');
		expect(deleteCrateServer).toHaveBeenCalledOnce();
		expect(h.loadArtifacts).not.toHaveBeenCalled();
		expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
		expect(apiMocks.queryD1).not.toHaveBeenCalled();
		expect(h.settings.cloudflareDeployment).toBeNull();
		expect(h.transportCalls.some(call => call.url.endsWith('/oauth2/revoke'))).toBe(true);
	});

	it('keeps metadata and revokes access if deletion fails', async () => {
		const h = resetHarness();
		deleteCrateServer.mockRejectedValue(new Error('Interrupted'));
		await h.service.startDeployment('delete');
		await expect(h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }, h.selectDeployment)).rejects.toThrow('Interrupted');
		expect(h.settings.cloudflareDeployment).not.toBeNull();
		expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
		expect(h.transportCalls.some(call => call.url.endsWith('/oauth2/revoke'))).toBe(true);
	});


});

function savedServer() {
	return { deploymentId: '0123456789abcdef', accountId: CLIENT_ID, accountName: 'Personal',
		workerName: 'crate-0123456789abcdef', d1DatabaseName: 'crate-0123456789abcdef',
		d1DatabaseId: 'old-db', r2BucketName: 'crate-0123456789abcdef', workersSubdomain: 'example',
		lastDeployedVersion: '0.1.0', lastDeployedFingerprint: null };
}

describe('server selection', () => {
	it('preserves the current server and sync when selection is cancelled', async () => {
		const h = createHarness();
		h.settings.cloudflareDeployment = savedServer();
		h.selectDeployment.mockResolvedValue(null);
		await h.service.startDeployment('switch');
		await expect(h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }, h.selectDeployment)).rejects.toThrow('No Cloudflare server');
		expect(h.beforeServerSwitch).not.toHaveBeenCalled();
		expect(h.persisted).toEqual([]);
		expect(h.settings.cloudflareDeployment).toEqual(savedServer());
	});

	it('switches to a selected server without replacing its Worker', async () => {
		const h = createHarness();
		h.settings.cloudflareDeployment = savedServer();
		const selected = { ...savedServer(), deploymentId: 'fedcba9876543210', workerName: 'crate-fedcba9876543210', d1DatabaseId: 'new-db' };
		h.selectDeployment.mockResolvedValue({ metadata: selected, modifiedOn: null });
		h.beforeServerSwitch.mockImplementation(async () => { expect(h.settings.cloudflareDeployment).toEqual(savedServer()); });
		await h.service.startDeployment('switch');
		await h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }, h.selectDeployment);
		expect(h.beforeServerSwitch).toHaveBeenCalledOnce();
		expect(h.settings.cloudflareDeployment?.d1DatabaseId).toBe('new-db');
		expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
	});

	it.each([1, 2])('reconnects with %i available vaults', async count => {
		const h = createHarness();
		const saved = savedServer();
		h.settings.cloudflareDeployment = saved;
		apiMocks.workers = [{ id: saved.workerName }];
		apiMocks.workerSettings.set(saved.workerName, {
			annotations: { 'workers/message': 'Crate 0.1.0' },
			bindings: [{ type: 'd1', name: 'DB', id: saved.d1DatabaseId },
				{ type: 'r2_bucket', name: 'BUCKET', bucket_name: saved.r2BucketName },
				{ type: 'durable_object_namespace', name: 'REMINDER_ALARMS', class_name: 'ReminderAlarm' }],
		});
		if (count === 2) {
			const otherName = 'crate-fedcba9876543210';
			apiMocks.workers.unshift({ id: otherName, modified_on: '2026-09-18' });
			apiMocks.workerSettings.set(otherName, apiMocks.workerSettings.get(saved.workerName));
		}
		await h.service.startDeployment('connect');
		await h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }, h.selectDeployment);
		expect(h.selectDeployment).not.toHaveBeenCalled();
		expect(h.settings.cloudflareDeployment?.workerName).toBe(saved.workerName);
		expect(h.beforeServerSwitch).not.toHaveBeenCalled();
		expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
	});

	it.each(['create', 'cancel'] as const)('lets a new vault %s instead of joining the only existing server', async choice => {
		const h = createHarness();
		const existing = savedServer();
		apiMocks.workers = [{ id: existing.workerName }];
		apiMocks.workerSettings.set(existing.workerName, {
			annotations: { 'workers/message': 'Crate 0.1.0' },
			bindings: [{ type: 'd1', name: 'DB', id: existing.d1DatabaseId },
				{ type: 'r2_bucket', name: 'BUCKET', bucket_name: existing.r2BucketName },
				{ type: 'durable_object_namespace', name: 'REMINDER_ALARMS', class_name: 'ReminderAlarm' }],
		});
		h.selectDeployment.mockResolvedValue(choice === 'create' ? 'create' : null);
		await h.service.startDeployment();
		const result = h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }, h.selectDeployment);
		if (choice === 'cancel') {
			await expect(result).rejects.toThrow('No Cloudflare server');
			expect(h.persisted).toEqual([]);
			expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
		} else {
			await result;
			expect(provisionCloudflareDeployment).toHaveBeenCalledOnce();
			expect(h.settings.cloudflareDeployment?.workerName).not.toBe(existing.workerName);
			expect(h.settings.cloudflareDeployment?.r2BucketName).not.toBe(existing.r2BucketName);
			expect(h.settings.cloudflareDeployment?.vaultName).toBe('Local vault');
		}
		expect(h.selectDeployment).toHaveBeenCalledOnce();
		expect(h.selectDeployment.mock.calls[0]?.[0]).toHaveLength(1);
		expect(h.selectDeployment.mock.calls[0]?.[0][0]?.metadata.workerName).toBe(existing.workerName);
		expect(apiMocks.queryD1).not.toHaveBeenCalled();
	});

	it('offers creation during reconnect when the saved server is gone', async () => {
		const h = createHarness();
		h.settings.cloudflareDeployment = savedServer();
		h.selectDeployment.mockResolvedValue('create');
		await h.service.startDeployment('connect');
		await h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }, h.selectDeployment);
		expect(h.selectDeployment).toHaveBeenCalledWith([], true);
		expect(h.beforeServerSwitch).toHaveBeenCalledOnce();
		expect(h.settings.cloudflareDeployment?.workerName).not.toBe(savedServer().workerName);
		expect(provisionCloudflareDeployment).toHaveBeenCalledOnce();
	});

	it('creates a fresh server identity instead of reusing the remembered server', async () => {
		const h = createHarness();
		h.settings.cloudflareDeployment = savedServer();
		await h.service.startDeployment('create');
		await h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }, h.selectDeployment);
		expect(h.beforeServerSwitch).toHaveBeenCalledOnce();
		expect(h.selectDeployment).not.toHaveBeenCalled();
		expect(h.settings.cloudflareDeployment?.workerName).not.toBe(savedServer().workerName);
		expect(provisionCloudflareDeployment).toHaveBeenCalledOnce();
	});

	it('offers recovery for a missing remembered server without creating on cancellation', async () => {
		const h = createHarness();
		h.settings.cloudflareDeployment = savedServer();
		h.selectDeployment.mockResolvedValue(null);
		await h.service.startDeployment('connect');
		await expect(h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }, h.selectDeployment)).rejects.toThrow('No Cloudflare server');
		expect(h.selectDeployment).toHaveBeenCalledWith([], true);
		expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
		expect(h.persisted).toEqual([]);
	});
});

it('retains successful setup authorization for usage instead of revoking it', async () => {
	const retain = vi.fn();
	const h = createHarness(retain);
	await h.service.startDeployment();
	await h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }, h.selectDeployment);
	expect(retain).toHaveBeenCalledWith(h.settings.cloudflareDeployment!.accountId, expect.objectContaining({ accessToken: 'temporary-access-token' }));
	expect(h.transportCalls.some(call => call.url.endsWith('/revoke'))).toBe(false);
	expect(h.persisted.join('')).not.toContain('temporary-access-token');
});

it('revokes authorization when saving the shared login fails', async () => {
	const h = createHarness(() => { throw new Error('Secret storage unavailable'); });
	await h.service.startDeployment();
	await expect(h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }, h.selectDeployment)).rejects.toThrow('Secret storage unavailable');
	expect(h.transportCalls.at(-1)?.url).toContain('/revoke');
});

it('updates with saved authorization without exchanging or revoking credentials', async () => {
	const h = createHarness();
	await h.service.startDeployment();
	await h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }, h.selectDeployment);
	h.transportCalls.length = 0;
	h.opened.length = 0;
	provisionCloudflareDeployment.mockClear();
	await h.service.deployWithSavedAuthorization('update', operation => operation({ accessToken: 'saved', scope: CLOUDFLARE_OAUTH_SCOPES.join(' ') }), h.selectDeployment);
	expect(apiMocks.constructedWithTokens.at(-1)).toBe('saved');
	expect(provisionCloudflareDeployment).toHaveBeenCalledOnce();
	expect(h.opened).toHaveLength(0);
	expect(h.transportCalls).toHaveLength(0);
});

it('rejects missing saved permissions before provisioning', async () => {
	const h = createHarness();
	await h.service.startDeployment();
	await h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }, h.selectDeployment);
	provisionCloudflareDeployment.mockClear();
	await expect(h.service.deployWithSavedAuthorization('update', operation => operation({ accessToken: 'analytics', scope: 'account-analytics.read' }), h.selectDeployment)).rejects.toThrow('Reconnect Cloudflare');
	expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
});

it('stops a saved update if the selected server changes while renewing authorization', async () => {
	const h = createHarness();
	await h.service.startDeployment();
	await h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }, h.selectDeployment);
	provisionCloudflareDeployment.mockClear();
	await expect(h.service.deployWithSavedAuthorization('update', operation => {
		h.settings.cloudflareDeployment!.accountId = 'different-account';
		return operation({ accessToken: 'saved' });
	}, h.selectDeployment)).rejects.toThrow('Server settings changed');
	expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
});

it('continues a saved update when the selected server is rewritten with reordered keys', async () => {
	const h = createHarness();
	await h.service.startDeployment();
	await h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }, h.selectDeployment);
	provisionCloudflareDeployment.mockClear();
	await h.service.deployWithSavedAuthorization('update', operation => {
		h.settings.cloudflareDeployment = Object.fromEntries(Object.entries(h.settings.cloudflareDeployment!).reverse()) as typeof h.settings.cloudflareDeployment;
		return operation({ accessToken: 'saved' });
	}, h.selectDeployment);
	expect(provisionCloudflareDeployment).toHaveBeenCalledOnce();
});

it.each(['delete'] as const)('rejects a changed confirmation target during saved %s authorization', async intent => {
	const h = createHarness();
	await h.service.startDeployment();
	await h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }, h.selectDeployment);
	h.settings.cloudflareDeployment!.d1DatabaseId = 'database';
	await expect(h.service.deployWithSavedAuthorization(intent, operation => {
		h.settings.cloudflareDeployment!.workerName = 'different-worker';
		return operation({ accessToken: 'saved' });
	}, h.selectDeployment)).rejects.toThrow('Server settings changed');
	expect(deleteCrateServer).not.toHaveBeenCalled();
});


it.each([false, true])('reconnects the saved server without publishing code (new device: %s)', async renew => {
	const h = resetHarness();
	await h.service.deployWithSavedAuthorization('reconnect', operation => operation({ accessToken: 'saved' }), h.selectDeployment, renew ? resetDevice : undefined);
	expect(h.loadArtifacts).not.toHaveBeenCalled();
	expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
	expect(h.selectDeployment).not.toHaveBeenCalled();
	expect(apiMocks.queryD1.mock.calls.length > 0).toBe(renew);
});

it('keeps reconnect bound to its saved server across browser authorization', async () => {
	const h = resetHarness();
	await h.service.startDeployment('reconnect');
	const state = firstOpenedUrl(h.opened).searchParams.get('state')!;
	h.settings.cloudflareDeployment!.workerName = 'another-server';
	await expect(h.service.handleCallback({ state, code: 'code' }, h.selectDeployment, resetDevice)).rejects.toThrow('Server settings changed');
	expect(apiMocks.queryD1).not.toHaveBeenCalled();
	expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
});

it.each(['connect', 'reconnect', 'switch', 'create', 'update'] as const)('blocks %s while terminal deletion is pending', async intent => {
	const h = resetHarness();
	h.settings.cloudflareDeployment!.deletion = { id: 'a'.repeat(32), phase: 'clearing-bucket', databaseId: h.settings.cloudflareDeployment!.d1DatabaseId!,
		bucketCreatedAt: 'date', workerCreatedAt: 'date', helperName: `crate-delete-${'a'.repeat(32)}` };
	await expect(h.service.startDeployment(intent)).rejects.toThrow('Resume server deletion');
});

describe('pending server operations', () => {
	const deletion = { id: 'b'.repeat(32), phase: 'removing-worker' as const, databaseId: 'old-db', bucketCreatedAt: null, workerCreatedAt: null, helperName: `crate-delete-${'b'.repeat(32)}` };
	const saved = (pending: Partial<CloudflareDeploymentMetadata>): CloudflareDeploymentMetadata => ({ ...savedServer(), ...pending });
	const intents: DeploymentIntent[] = ['reconnect', 'connect', 'switch', 'create', 'update', 'delete'];
	const cases: Array<[string, CloudflareDeploymentMetadata | null, Partial<Record<DeploymentIntent, 'deletion'>>]> = [
		['no saved server', null, {}],
		['no pending operation', saved({}), {}],
		['a deletion', saved({ deletion }), { reconnect: 'deletion', connect: 'deletion', switch: 'deletion', create: 'deletion', update: 'deletion' }],
	];
	it.each(cases)('admits only deleting with %s', (_label, metadata, blocked) => {
		expect(Object.fromEntries(intents.map(intent => [intent, blockingServerOperation(metadata, intent)])))
			.toEqual(Object.fromEntries(intents.map(intent => [intent, blocked[intent] ?? null])));
	});
});

describe('mobile server changes', () => {
	const mobile = () => createHarness(undefined, { serverChangesAllowed: false });
	const saved = (h: ReturnType<typeof createHarness>) => {
		h.settings.cloudflareDeployment = { ...savedServer(), accountId: apiMocks.accounts[0]!.id };
	};
	const authorize = (h: ReturnType<typeof createHarness>, device?: Parameters<typeof h.service.handleCallback>[2]) =>
		h.service.handleCallback({ code: 'code', state: firstOpenedUrl(h.opened).searchParams.get('state')! }, h.selectDeployment, device);
	const existingServer = () => {
		apiMocks.workers = [{ id: 'crate-fedcba9876543210' }];
		apiMocks.workerSettings.set('crate-fedcba9876543210', { annotations: { 'workers/message': 'Crate 9.0.0' }, bindings: [
			{ type: 'd1', name: 'DB', id: 'existing-database-id' },
			{ type: 'r2_bucket', name: 'BUCKET', bucket_name: 'crate-fedcba9876543210' },
			{ type: 'durable_object_namespace', name: 'REMINDER_ALARMS', class_name: 'ReminderAlarm' },
		] });
	};

	it.each(['create', 'update', 'delete'] as const)('refuses %s before opening authorization', async intent => {
		const h = mobile();
		saved(h);
		await expect(h.service.startDeployment(intent)).rejects.toThrow(DesktopOnlyServerChangeError);
		expect(h.opened).toHaveLength(0);
	});

	it('refuses saved-login changes without using the login', async () => {
		const h = mobile();
		saved(h);
		const withAuthorization = vi.fn();
		await expect(h.service.deployWithSavedAuthorization('update', withAuthorization, h.selectDeployment)).rejects.toThrow(DesktopOnlyServerChangeError);
		await expect(h.service.recoverUpdate(withAuthorization)).rejects.toThrow(DesktopOnlyServerChangeError);
		await expect(h.service.listRestoreBackups(withAuthorization)).rejects.toThrow(DesktopOnlyServerChangeError);
		expect(withAuthorization).not.toHaveBeenCalled();
	});

	it('connects to an existing server', async () => {
		existingServer();
		const h = mobile();
		await h.service.startDeployment();
		await expect(authorize(h, resetDevice)).resolves.toEqual(expect.objectContaining({ status: 'deployed' }));
		expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
		expect(h.settings.cloudflareDeployment?.d1DatabaseId).toBe('existing-database-id');
	});

	it('does not create a server when connecting finds none', async () => {
		const h = mobile();
		await h.service.startDeployment();
		await expect(authorize(h, resetDevice)).rejects.toThrow(DesktopOnlyServerChangeError);
		expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
		expect(h.beforeServerSwitch).not.toHaveBeenCalled();
		expect(h.settings.cloudflareDeployment).toBeNull();
		expect(h.transportCalls.some(call => call.url.endsWith('/oauth2/revoke'))).toBe(true);
	});
});

describe('device pairing codes', () => {
	it('records only the code hash through the saved login and returns the code once', async () => {
		const h = createHarness();
		h.settings.cloudflareDeployment = { ...savedServer(), accountId: apiMocks.accounts[0]!.id };
		const issued = await h.service.issueDevicePairing(operation => operation({ accessToken: 'saved', scope: CLOUDFLARE_OAUTH_SCOPES.join(' ') }));
		expect(issued.code).toMatch(/^[a-f0-9]{64}$/);
		const calls = apiMocks.queryD1.mock.calls.map(call => JSON.stringify(call));
		expect(calls).toHaveLength(2);
		expect(calls.join()).not.toContain(issued.code);
		expect(calls[1]).toContain(issued.tokenId);
		expect(h.opened).toEqual([]);
	});

	it.each(['no saved server', 'a pending deletion'])('refuses %s before using the login', async reason => {
		const h = createHarness();
		if (reason === 'a pending deletion') h.settings.cloudflareDeployment = { ...savedServer(), deletion: { id: 'b'.repeat(32), phase: 'removing-worker', databaseId: 'old-db', bucketCreatedAt: null, workerCreatedAt: null, helperName: 'helper' } };
		const withAuthorization = vi.fn();
		await expect(h.service.issueDevicePairing(withAuthorization)).rejects.toThrow('Connect this vault');
		expect(withAuthorization).not.toHaveBeenCalled();
	});
});

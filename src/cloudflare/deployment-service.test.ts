import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type CrateSettings } from '../plugin/settings';
import type { HttpTransport } from './http';
import type { DiscoveredCloudflareDeployment } from './deployment-discovery';
import {
	CLOUDFLARE_OAUTH_REDIRECT_URL,
	CLOUDFLARE_OAUTH_SCOPES,
} from './oauth-config';

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
	const service = new CloudflareDeploymentService({
		clientId: CLIENT_ID,
		settingsOwner,
		transport,
		loadArtifacts: vi.fn(async () => ({
			version: '0.1.0',
			fingerprint: 'f'.repeat(64),
			workerBundle: 'export default {};',
			workerBundleSha256: 'worker-hash',
			d1Migrations: [],
		})),
		openExternal: url => opened.push(url),
		selectDeployment: vi.fn(async (deployments: DiscoveredCloudflareDeployment[]) => deployments[0] ?? null),
		now: () => 1_000,
	});
	return { service, settings, settingsOwner, persisted, opened, transportCalls, transport };
}

beforeEach(() => {
	apiMocks.accounts = [{ id: '0123456789abcdef0123456789abcdef', name: 'Personal' }];
	apiMocks.constructedWithTokens.length = 0;
	apiMocks.workers = [];
	apiMocks.workerSettings.clear();
	apiMocks.queryD1.mockReset();
	apiMocks.queryD1.mockResolvedValue([{ results: [] }]);
	provisionCloudflareDeployment.mockClear();
});

describe('CloudflareDeploymentService', () => {
	it('opens Cloudflare authorization with PKCE S256 and minimum scopes', async () => {
		const harness = createHarness();
		await harness.service.startDeployment();

		const authorizationUrl = new URL(harness.opened[0]);
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
		const state = new URL(harness.opened[0]).searchParams.get('state');
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

		const tokenRequestBody = harness.transportCalls[0].body;
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
		const state = new URL(harness.opened[0]).searchParams.get('state');
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
			annotations: { 'workers/message': 'Crate 0.1.0' },
			bindings: [
				{ type: 'd1', name: 'DB', id: 'existing-database-id' },
				{ type: 'r2_bucket', name: 'BUCKET', bucket_name: 'crate-fedcba9876543210' },
				{ type: 'durable_object_namespace', name: 'REMINDER_ALARMS', class_name: 'ReminderAlarm' },
			],
		});
		const harness = createHarness();
		await harness.service.startDeployment();
		const state = new URL(harness.opened[0]).searchParams.get('state');
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
	});

	it('requires a single newly authorized account and still revokes the token', async () => {
		apiMocks.accounts = [
			{ id: '0123456789abcdef0123456789abcdef', name: 'First' },
			{ id: 'fedcba9876543210fedcba9876543210', name: 'Second' },
		];
		const harness = createHarness();
		await harness.service.startDeployment();
		const state = new URL(harness.opened[0]).searchParams.get('state');
		if (!state) throw new Error('Missing OAuth state');

		await expect(harness.service.handleCallback({ code: 'code', state }))
			.rejects.toThrow('exactly one Cloudflare account');
		expect(provisionCloudflareDeployment).not.toHaveBeenCalled();
		expect(harness.transportCalls.at(-1)?.url).toContain('/oauth2/revoke');
	});
});

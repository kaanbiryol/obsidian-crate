import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type CratePlugin from '../../plugin/CratePlugin';
import type { SharedSettings } from '../../protocol/shared-settings';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol/server-info';
import { SyncApiClient } from '../../sync/worker-api/client';
import type { ApiHttpResponse, ApiHttpTransport } from '../../sync/worker-api/http';
import { Notice } from '../../test/mocks/obsidian';
import { createSharedSettingsPush, SHARED_SETTINGS_CONFLICT_NOTICE } from './shared-settings-push';

const WORKER_URL = 'https://worker.example';
const otherDevice: SharedSettings = { ignorePatterns: ['Archive/'], syncInterval: 300, pushEnabled: true };

function respond(status: number, data: unknown): ApiHttpResponse {
	const text = JSON.stringify(data);
	return { status, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer };
}

/** The Worker's /settings contract: a write must name the version it replaces. */
function settingsServer(settings: SharedSettings | null) {
	const server = { settings, version: settings ? 'v1' : null as string | null, writes: 0, failReads: 0 };
	const transport = vi.fn<ApiHttpTransport>(async request => {
		const path = new URL(request.url).pathname;
		if (path === '/.well-known/crate') {
			return respond(200, { service: 'crate', serverVersion: '0.1.0', protocol: CRATE_PLUGIN_PROTOCOL, reminderOperationDay: Math.floor(Date.now() / 86400000), capabilities: [] });
		}
		if (path !== '/settings') throw new Error(`Unexpected request: ${path}`);
		if (request.method !== 'PUT') {
			if (server.failReads > 0) { server.failReads--; return respond(400, { error: 'Server unavailable' }); }
			return respond(200, { settings: server.settings, settingsVersion: server.version });
		}
		const body = JSON.parse(request.body as string) as { settings: SharedSettings; expectedVersion: string | null };
		if (body.expectedVersion !== server.version) return respond(409, { error: 'Shared settings changed on another device' });
		server.settings = body.settings;
		server.version = `v${++server.writes + 1}`;
		return respond(200, { success: true, settingsVersion: server.version });
	});
	const requests = () => transport.mock.calls.map(([request]) => request).filter(request => request.url.endsWith('/settings'))
		.map(request => request.method === 'PUT' ? { PUT: JSON.parse(request.body as string) as unknown } : 'GET');
	return { server, transport, requests };
}

function fixture(remote: SharedSettings | null) {
	const { server, transport, requests } = settingsServer(remote);
	let api: SyncApiClient | null = new SyncApiClient(WORKER_URL, 'token', transport);
	const settings = { workerUrl: WORKER_URL, ignorePatterns: ['*.tmp'], syncInterval: 300, pushEnabled: false };
	const writeSettings = vi.fn(async (update: Partial<typeof settings>) => { Object.assign(settings, update); });
	const updateSyncSettings = vi.fn();
	const plugin = { settings, writeSettings, syncRuntime: { getApiClient: () => api, updateSyncSettings } };
	const sharedSettings = createSharedSettingsPush(plugin as unknown as CratePlugin);
	const editRemotely = (changes: Partial<SharedSettings>) => {
		server.settings = { ...server.settings!, ...changes };
		server.version = `remote-${server.version ?? 0}`;
	};
	return { server, requests, settings, writeSettings, updateSyncSettings, sharedSettings, editRemotely, setApi: (next: SyncApiClient | null) => { api = next; } };
}

beforeEach(() => {
	vi.stubGlobal('window', globalThis);
	Notice.reset();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('shared settings push on settings close', () => {
	it('does not write when this device changed no shared setting', async () => {
		const { sharedSettings, requests, server, settings } = fixture(otherDevice);
		sharedSettings.observe();
		await sharedSettings.push();
		settings.workerUrl = 'https://other.example';
		await sharedSettings.push();
		expect(requests()).toEqual([]);
		expect(server.settings).toEqual(otherDevice);
	});

	it('reads an unknown server version first and writes only this device\'s change', async () => {
		const { sharedSettings, requests, server, settings, updateSyncSettings } = fixture(otherDevice);
		sharedSettings.observe();
		settings.syncInterval = 120;
		await sharedSettings.push();

		const merged = { ...otherDevice, syncInterval: 120 };
		expect(requests()).toEqual(['GET', { PUT: { settings: merged, expectedVersion: 'v1' } }]);
		expect(server.settings).toEqual(merged);
		expect(settings).toMatchObject(merged);
		expect(updateSyncSettings).toHaveBeenCalledOnce();
		expect(Notice.messages).toEqual([]);
	});

	it('writes a later change against the version it last saw', async () => {
		const { sharedSettings, requests, settings } = fixture(otherDevice);
		settings.syncInterval = 120;
		await sharedSettings.push();
		settings.pushEnabled = false;
		await sharedSettings.push();

		expect(requests().slice(2)).toEqual([{ PUT: { settings: { ...otherDevice, syncInterval: 120, pushEnabled: false }, expectedVersion: 'v2' } }]);
	});

	it('creates shared settings only while the server has none', async () => {
		const { sharedSettings, requests, settings } = fixture(null);
		settings.ignorePatterns = ['*.tmp', 'Private/'];
		await sharedSettings.push();

		const local = { ignorePatterns: ['*.tmp', 'Private/'], syncInterval: 300, pushEnabled: false };
		expect(requests()).toEqual(['GET', { PUT: { settings: local, expectedVersion: null } }]);
	});

	it('loads newer server settings instead of overwriting them', async () => {
		const { sharedSettings, requests, server, settings, editRemotely } = fixture(otherDevice);
		settings.syncInterval = 120;
		await sharedSettings.push();
		editRemotely({ ignorePatterns: ['Inbox/'] });
		settings.pushEnabled = false;
		await sharedSettings.push();

		const remote = { ...otherDevice, syncInterval: 120, ignorePatterns: ['Inbox/'] };
		expect(requests().slice(2)).toEqual([
			{ PUT: { settings: { ...otherDevice, syncInterval: 120, pushEnabled: false }, expectedVersion: 'v2' } },
			'GET',
		]);
		expect(server.settings).toEqual(remote);
		expect(settings).toMatchObject(remote);
		expect(Notice.messages).toEqual([SHARED_SETTINGS_CONFLICT_NOTICE]);
	});

	it('loads a setting another device also changed instead of overwriting it', async () => {
		const { sharedSettings, requests, server, settings } = fixture({ ignorePatterns: ['*.tmp'], syncInterval: 60, pushEnabled: false });
		settings.syncInterval = 120;
		await sharedSettings.push();

		expect(requests()).toEqual(['GET']);
		expect(server.settings?.syncInterval).toBe(60);
		expect(settings.syncInterval).toBe(60);
		expect(Notice.messages).toEqual([SHARED_SETTINGS_CONFLICT_NOTICE]);
	});

	it('keeps a change that could not be saved for the next close', async () => {
		const { sharedSettings, requests, server, settings } = fixture(otherDevice);
		server.failReads = 1;
		settings.syncInterval = 120;
		await sharedSettings.push();
		await sharedSettings.push();

		expect(requests()).toEqual(['GET', 'GET', { PUT: { settings: { ...otherDevice, syncInterval: 120 }, expectedVersion: 'v1' } }]);
	});

	it('waits for a sync connection', async () => {
		const { sharedSettings, requests, settings, setApi } = fixture(otherDevice);
		setApi(null);
		settings.syncInterval = 120;
		await sharedSettings.push();
		expect(requests()).toEqual([]);
	});
});

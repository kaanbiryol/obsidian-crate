import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type CrateSettings } from '../plugin/settings';
import { CloudflareDeploymentService } from './deployment-service';
import type { CloudflareWorkerSettings } from './cloudflare-api';
import type { HttpTransport } from './http';
import { createFenceQueryHarness } from './deployment-fence-test-harness';
import { sha256Hex } from './deployment-artifacts';

// Exercise the real service, API client and reset/delete implementation through
// a local transport. Remote mutations happen before their response is released.
function harness() {
	const fence = createFenceQueryHarness();
	const accountId = 'a'.repeat(32);
	const name = 'crate-0123456789abcdef';
	const databaseId = '01234567-89ab-cdef-0123-456789abcdef';
	const settings: CrateSettings = {
		...DEFAULT_SETTINGS,
		cloudflareDeployment: {
			deploymentId: '0123456789abcdef', accountId, accountName: 'Personal',
			workerName: name, d1DatabaseName: name, d1DatabaseId: databaseId,
			r2BucketName: name, workersSubdomain: 'example', lastDeployedVersion: '0.1.0', lastDeployedFingerprint: null,
		},
	};
	const worker: CloudflareWorkerSettings = {
		annotations: { 'workers/message': 'Crate 0.1.0' },
		bindings: [
			{ type: 'd1', name: 'DB', id: databaseId },
			{ type: 'r2_bucket', name: 'BUCKET', bucket_name: name },
			{ type: 'durable_object_namespace', name: 'REMINDER_ALARMS', class_name: 'ReminderAlarm', namespace_id: 'c'.repeat(32) },
		],
	};
	const remote = { worker: true, bucket: true, database: true, retired: false };
	const objects = new Set(['__crate__/settings.json', `__crate__/files/${'b'.repeat(64)}/01234567-89ab-cdef-0123-456789abcdef`]);
	const mutations: string[] = [];
	const writeSettings = vi.fn(async (update: Partial<CrateSettings>) => {
		Object.assign(settings, structuredClone(update));
	});
	const json = (result: unknown, status = 200) => ({ status, text: JSON.stringify({ success: status === 200, result, result_info: { total_pages: 1 } }) });
	const transport = vi.fn<HttpTransport>(async (url, request) => {
		const path = new URL(url).pathname;
		if (path === '/oauth2/token') return { status: 200, text: JSON.stringify({ access_token: 'temporary-token' }) };
		if (path === '/oauth2/revoke') return { status: 200, text: '{}' };
		if (path === '/client/v4/memberships') return json([{ status: 'accepted', account: { id: accountId, name: 'Personal' } }]);
		if (path.endsWith('/workers/subdomain')) return json({ subdomain: 'example' });
		if (path === '/.well-known/crate-reset') return { status: 200, text: JSON.stringify({ service: 'crate-reset', protocol: 1, resetId: settings.cloudflareDeployment!.reset!.id }) };
		if (path === '/__crate__/reset/objects' && request.method === 'POST' && typeof request.body === 'string') {
			const [result] = fence.query('SELECT value FROM maintenance_state WHERE key = ?;', ['crate_deployment_fence'])!;
			const record = JSON.parse(result!.results[0]!.value as string) as Record<string, unknown>;
			const keys = JSON.parse(request.body) as string[];
			const token = request.headers?.Authorization?.replace('Bearer ', '') ?? '';
			if (record.cleanupTokenHash !== await sha256Hex(token) || record.batchHash !== await sha256Hex(request.body)
				|| record.stepState !== 'started') return { status: 403, text: 'Unauthorized batch' };
			mutations.push(path);
			keys.forEach(key => objects.delete(key));
			return { status: 200, text: JSON.stringify({ service: 'crate-reset', protocol: 1, resetId: settings.cloudflareDeployment!.reset!.id, batchHash: record.batchHash, deleted: keys.length }) };
		}
		if (path.endsWith('/workers/scripts')) return json(remote.worker ? [{ id: name }] : []);
		if (path.endsWith('/settings')) return json(worker);
		if (path.endsWith('/durable_objects/namespaces')) return json(remote.retired ? [] : [{ id: 'c'.repeat(32), script: name, class: 'ReminderAlarm' }]);
		if (request.method === 'DELETE') {
			mutations.push(path);
			if (path.endsWith(`/r2/buckets/${name}`)) remote.bucket = false;
			else if (path.endsWith(`/d1/database/${databaseId}`)) remote.database = false;
			else if (path.endsWith(`/workers/scripts/${name}`)) remote.worker = false;
			else throw new Error(`Unexpected deletion: ${path}`);
			return json({});
		}
		if (request.method === 'PUT' && path.endsWith(`/workers/scripts/${name}`)) {
			mutations.push(path);
			remote.retired = true;
			worker.annotations = { 'workers/message': `Crate reset ${settings.cloudflareDeployment!.reset!.id}` };
			worker.bindings = [...worker.bindings!.filter(binding => ['d1', 'r2_bucket'].includes(binding.type!)),
				{ type: 'plain_text', name: 'CRATE_RESET_ID', text: settings.cloudflareDeployment!.reset!.id }];
			return json({});
		}
		if (path.endsWith(`/d1/database/${databaseId}`)) return remote.database ? json({ uuid: databaseId, name }) : json(null, 404);
		if (path.endsWith(`/r2/buckets/${name}`)) return remote.bucket ? json({ name, creation_date: '2026-01-01' }) : json(null, 404);
		if (path.endsWith('/objects')) {
			const offset = Number(new URL(url).searchParams.get('cursor') ?? 0);
			return { status: 200, text: JSON.stringify({ success: true, result: [...objects].slice(offset, offset + 1000).map(key => ({ key })),
				result_info: offset + 1000 < objects.size ? { cursor: String(offset + 1000) } : {} }) };
		}
		if (path.endsWith('/query') && typeof request.body === 'string') {
			const { sql, params } = JSON.parse(request.body) as { sql: string; params?: string[] };
			const fenced = fence.query(sql, params);
			if (fenced) return json(fenced);
			return json([{ results: sql.startsWith('PRAGMA') ? [{ name: 'storage_key' }] : ['files', 'auth_tokens'].map(name => ({ name })) }]);
		}
		throw new Error(`Unexpected request: ${request.method} ${path}`);
	});
	const beforeServerReset = vi.fn(async () => {});
	function createService(send: HttpTransport = transport) {
		const opened: string[] = [];
		const service = new CloudflareDeploymentService({
			clientId: 'd'.repeat(32), settingsOwner: { settings, writeSettings }, transport: send,
			loadArtifacts: async () => ({ version: '0.1.0', fingerprint: 'f'.repeat(64), workerBundle: '', workerBundleSha256: '', d1Schema: '', d1SchemaSha256: '' }),
			openExternal: url => { opened.push(url); }, selectDeployment: async () => null, beforeServerReset,
		});
		return {
			service,
			authorize: async (intent: 'reset' | 'delete') => {
				await service.startDeployment(intent);
				return { code: 'code', state: new URL(opened.at(-1)!).searchParams.get('state')! };
			},
		};
	}
	return { settings, writeSettings, mutations, objects, remote, transport, beforeServerReset, createService };
}

const device = { tokenHash: 'hash', deviceId: 'device', deviceName: 'Test', platform: 'desktop' };

describe('Cloudflare deployment interruption and recovery', () => {
	it.each(['reset', 'delete'] as const)('stops %s during object clearing and preserves the saved recovery checkpoint', async intent => {
		const h = harness();
		for (let i = 0; i < 1498; i++) h.objects.add(`__crate__/files/${i.toString(16).padStart(64, '0')}/01234567-89ab-cdef-0123-456789abcdef`);
		let release!: () => void;
		const pending = new Promise<void>(resolve => { release = resolve; });
		let dispatched = false;
		const transport: HttpTransport = async (url, request) => {
			const response = await h.transport(url, request);
			if (request.method === 'POST' && url.endsWith('/__crate__/reset/objects')) {
				dispatched = true;
				await pending;
			}
			return response;
		};
		const first = h.createService(transport);
		const params = await first.authorize(intent);
		const running = first.service.handleCallback(params, device);
		const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(dispatched).toBe(true));
		const checkpoint = structuredClone(h.settings.cloudflareDeployment!.reset);
		const writes = h.writeSettings.mock.calls.length;
		first.service.destroy();
		release();
		await rejected;
		expect(h.objects.size).toBe(500);
		expect(h.remote).toEqual({ worker: true, bucket: true, database: true, retired: true });
		expect(h.mutations).toHaveLength(2); // The retired Worker and one bulk request; no second batch.
		expect(h.writeSettings).toHaveBeenCalledTimes(writes);
		expect(h.settings.cloudflareDeployment!.reset).toEqual(checkpoint);
		expect(checkpoint?.phase).toBe('clearing');
		expect(vi.mocked(h.transport).mock.calls.at(-1)?.[0]).toContain('/oauth2/revoke');

		if (intent === 'delete') {
			const retry = h.createService();
			const result = await retry.service.handleCallback(await retry.authorize('delete'));
			expect(result.deleted).toBe(true);
			expect(h.settings.cloudflareDeployment).toBeNull();
			expect(h.remote).toEqual({ worker: false, bucket: false, database: false, retired: true });
			expect(h.objects.size).toBe(0);
			// No repeated Worker retirement, object deletion or database deletion.
			expect(h.mutations).toHaveLength(6);
		}
	});

	it('stops before remote removal when destroyed while local sync shuts down', async () => {
		const h = harness();
		const first = h.createService();
		h.beforeServerReset.mockImplementation(async () => { first.service.destroy(); });
		await expect(first.service.handleCallback(await first.authorize('reset'), device))
			.rejects.toMatchObject({ name: 'AbortError' });
		expect(h.mutations).toEqual([]);
		expect(h.settings.cloudflareDeployment!.reset).toBeUndefined();
		expect(vi.mocked(h.transport).mock.calls.at(-1)?.[0]).toContain('/oauth2/revoke');
	});
});

it('deletes with saved credentials through the real deletion path without opening OAuth or revoking the shared login', async () => {
	const h = harness();
	const { service } = h.createService();
	const result = await service.deployWithSavedAuthorization('delete', async operation => {
		const result = await operation({ accessToken: 'saved' });
		// Keep the account available until the shared credential operation settles.
		expect(h.settings.cloudflareDeployment?.accountId).toBe('a'.repeat(32));
		return result;
	});
	expect(result.deleted).toBe(true);
	expect(h.settings.cloudflareDeployment).toBeNull();
	expect(h.remote).toMatchObject({ worker: false, database: false, bucket: false });
	expect(h.transport.mock.calls.some(([url]) => url.includes('/oauth2/'))).toBe(false);
});

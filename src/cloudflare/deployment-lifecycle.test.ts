import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type CrateSettings } from '../plugin/settings';
import { CloudflareDeploymentService } from './deployment-service';
import type { CloudflareWorkerSettings } from './cloudflare-api';
import type { HttpTransport } from './http';
import { createFenceQueryHarness } from './deployment-fence-test-harness';

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
		if (path.endsWith('/workers/scripts')) return json(remote.worker ? [{ id: name }] : []);
		if (path.endsWith('/settings')) return json(worker);
		if (path.endsWith('/durable_objects/namespaces')) return json(remote.retired ? [] : [{ id: 'c'.repeat(32), script: name, class: 'ReminderAlarm' }]);
		if (request.method === 'DELETE') {
			mutations.push(path);
			if (path.includes('/objects/')) objects.delete(decodeURIComponent(path.split('/objects/')[1]!));
			else if (path.endsWith(`/r2/buckets/${name}`)) remote.bucket = false;
			else if (path.endsWith(`/d1/database/${databaseId}`)) remote.database = false;
			else if (path.endsWith(`/workers/scripts/${name}`)) remote.worker = false;
			else throw new Error(`Unexpected deletion: ${path}`);
			return json({});
		}
		if (request.method === 'PUT' && path.endsWith(`/workers/scripts/${name}`)) {
			mutations.push(path);
			remote.retired = true;
			worker.annotations = { 'workers/message': `Crate reset ${settings.cloudflareDeployment!.reset!.id}` };
			worker.bindings = worker.bindings!.filter(binding => binding.type !== 'durable_object_namespace');
			return json({});
		}
		if (path.endsWith(`/d1/database/${databaseId}`)) return remote.database ? json({ uuid: databaseId, name }) : json(null, 404);
		if (path.endsWith(`/r2/buckets/${name}`)) return remote.bucket ? json({ name, creation_date: '2026-01-01' }) : json(null, 404);
		if (path.endsWith('/objects')) return json([...objects].map(key => ({ key })));
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
	return { settings, writeSettings, mutations, objects, remote, transport, beforeServerReset, createService, clearFence: fence.clear };
}

const device = { tokenHash: 'hash', deviceId: 'device', deviceName: 'Test', platform: 'desktop' };

describe('Cloudflare deployment interruption and recovery', () => {
	it.each(['reset', 'delete'] as const)('stops %s during object clearing and preserves the saved recovery checkpoint', async intent => {
		const h = harness();
		let release!: () => void;
		let paused = false;
		const transport: HttpTransport = async (url, request) => {
			const response = await h.transport(url, request);
			if (!paused && request.method === 'DELETE' && url.includes('/objects/')) {
				paused = true;
				await new Promise<void>(resolve => { release = resolve; });
			}
			return response;
		};
		const first = h.createService(transport);
		const params = await first.authorize(intent);
		const running = first.service.handleCallback(params, device);
		const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(release).toBeTypeOf('function'));
		const checkpoint = structuredClone(h.settings.cloudflareDeployment!.reset);
		const writes = h.writeSettings.mock.calls.length;
		first.service.destroy();
		release();
		await rejected;
		expect(h.objects.size).toBe(1);
		expect(h.remote).toEqual({ worker: true, bucket: true, database: true, retired: true });
		expect(h.mutations).toHaveLength(2); // The retired Worker and one dispatched object deletion.
		expect(h.writeSettings).toHaveBeenCalledTimes(writes);
		expect(h.settings.cloudflareDeployment!.reset).toEqual(checkpoint);
		expect(checkpoint?.phase).toBe('clearing');
		expect(vi.mocked(h.transport).mock.calls.at(-1)?.[0]).toContain('/oauth2/revoke');

		if (intent === 'delete') {
			h.clearFence(); // Operator confirmed the interrupted request has settled.
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

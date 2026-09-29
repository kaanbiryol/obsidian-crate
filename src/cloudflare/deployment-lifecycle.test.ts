import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type CrateSettings } from '../plugin/settings';
import { CloudflareDeploymentService } from './deployment-service';
import type { CloudflareWorkerSettings } from './cloudflare-api';
import type { HttpTransport } from './http';
import { createFenceQueryHarness } from './deployment-fence-test-harness';
import { sha256Hex } from './deployment-artifacts';
import { SERVER_RELEASE } from './database-upgrades';

// Exercise the real service, API client and reset/delete implementation through
// a local transport. Remote mutations happen before their response is released.
function harness() {
	const fence = createFenceQueryHarness();
	const replacementFence = createFenceQueryHarness();
	const accountId = 'a'.repeat(32);
	const name = 'crate-0123456789abcdef';
	const databaseId = '01234567-89ab-cdef-0123-456789abcdef';
	const replacementId = 'fedcba98-7654-3210-fedc-ba9876543210';
	let replacementCreated = false;
	let initialized = false;
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
	const helpers = new Map<string, CloudflareWorkerSettings>();
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
		if (path.endsWith('/subdomain')) return json({ enabled: true, previews_enabled: false });
		if (path.endsWith('/schedules')) return json({});
		if (path === '/.well-known/crate') return { status: 200, text: JSON.stringify({ service: 'crate', deploymentFingerprint: 'f'.repeat(64), serverRevision: SERVER_RELEASE.revision, schemaVersion: SERVER_RELEASE.schemaVersion }) };
		if (path.endsWith('/d1/database')) {
			if (request.method === 'POST') { replacementCreated = true; mutations.push('create-database'); }
			const database = { uuid: replacementId, name };
			return json(request.method === 'POST' ? database : replacementCreated ? [database] : []);
		}
		if (path.endsWith(`/d1/database/${replacementId}`)) return json(replacementCreated ? { uuid: replacementId, name } : null, replacementCreated ? 200 : 404);
		if (path.endsWith('/r2/buckets') && request.method === 'POST') { remote.bucket = true; mutations.push('create-bucket'); return json({ name }); }
		if (path === '/.well-known/crate-reset') return { status: 200, text: JSON.stringify({ service: 'crate-reset', protocol: 1,
			resetId: settings.cloudflareDeployment!.deletion?.id ?? settings.cloudflareDeployment!.reset!.id,
			recoveryObjects: true, ...(settings.cloudflareDeployment!.deletion ? { deleteAll: true,
				uploadTag: helpers.get(new URL(url).hostname.split('.')[0]!)?.annotations?.['workers/tag'] } : {}) }) };
		if (path === '/__crate__/reset/objects' && request.method === 'POST' && typeof request.body === 'string') {
			const [result] = fence.query('SELECT value FROM maintenance_state WHERE key = ?;', ['crate_deployment_fence'])!;
			const record = JSON.parse(result!.results[0]!.value as string) as Record<string, unknown>;
			const keys = JSON.parse(request.body) as string[];
			const token = request.headers?.Authorization?.replace('Bearer ', '') ?? '';
			if (record.cleanupTokenHash !== await sha256Hex(token) || record.batchHash !== await sha256Hex(request.body)
				|| record.stepState !== 'started') return { status: 403, text: 'Unauthorized batch' };
			mutations.push(path);
			keys.forEach(key => objects.delete(key));
			return { status: 200, text: JSON.stringify({ service: 'crate-reset', protocol: 1,
				resetId: settings.cloudflareDeployment!.deletion?.id ?? settings.cloudflareDeployment!.reset!.id, batchHash: record.batchHash, deleted: keys.length }) };
		}
		if (path.endsWith('/workers/scripts')) return json([...(remote.worker ? [{ id: name, created_on: '2026-01-01' }] : []),
			...[...helpers.keys()].map(id => ({ id, created_on: '2026-09-29' }))]);
		if (path.endsWith('/settings')) {
			const target = path.split('/').at(-2)!;
			return target === name ? json(worker, remote.worker ? 200 : 404) : json(helpers.get(target), helpers.has(target) ? 200 : 404);
		}
		if (path.endsWith('/durable_objects/namespaces')) return json(remote.retired ? [] : [{ id: 'c'.repeat(32), script: name, class: 'ReminderAlarm' }]);
		if (request.method === 'DELETE') {
			mutations.push(path);
			if (path.endsWith(`/r2/buckets/${name}`)) remote.bucket = false;
			else if (path.endsWith(`/d1/database/${databaseId}`)) remote.database = false;
			else if (path.endsWith(`/workers/scripts/${name}`)) { remote.worker = false; remote.retired = true; }
			else if (helpers.has(path.split('/').at(-1)!)) helpers.delete(path.split('/').at(-1)!);
			else throw new Error(`Unexpected deletion: ${path}`);
			return json({});
		}
		if (request.method === 'PUT' && path.includes('/workers/scripts/crate-delete-')) {
			const body = new TextDecoder().decode(request.body as ArrayBuffer);
			const metadata = JSON.parse(body.split('\r\n\r\n')[1]!.split('\r\n--')[0]!) as CloudflareWorkerSettings;
			helpers.set(path.split('/').at(-1)!, metadata);
			mutations.push(path);
			return json({});
		}
		if (request.method === 'PUT' && path.endsWith(`/workers/scripts/${name}`)) {
			mutations.push(path);
			if (replacementCreated) {
				expect(new TextDecoder().decode(request.body as ArrayBuffer)).toContain(replacementId);
				worker.annotations = { 'workers/message': `Crate 0.1.0 ${'f'.repeat(64)}` };
				worker.bindings = [{ type: 'd1', name: 'DB', id: replacementId }, { type: 'r2_bucket', name: 'BUCKET', bucket_name: name },
					{ type: 'durable_object_namespace', name: 'REMINDER_ALARMS', class_name: 'ReminderAlarm', namespace_id: 'e'.repeat(32) }];
				return json({});
			}
			remote.retired = true;
			worker.annotations = { 'workers/message': `Crate reset ${settings.cloudflareDeployment!.reset!.id}` };
			worker.bindings = [...worker.bindings!.filter(binding => ['d1', 'r2_bucket'].includes(binding.type!)),
				{ type: 'plain_text', name: 'CRATE_RESET_ID', text: settings.cloudflareDeployment!.reset!.id }];
			return json({});
		}
		if (path.endsWith(`/d1/database/${databaseId}`)) return remote.database ? json({ uuid: databaseId, name }) : json(null, 404);
		if (path.endsWith(`/r2/buckets/${name}`)) return remote.bucket ? json({ name, creation_date: replacementCreated ? '2026-09-29' : '2026-01-01' }) : json(null, 404);
		if (path.endsWith('/objects')) {
			const offset = Number(new URL(url).searchParams.get('cursor') ?? 0);
			return { status: 200, text: JSON.stringify({ success: true, result: [...objects].slice(offset, offset + 1000).map(key => ({ key })),
				result_info: offset + 1000 < objects.size ? { cursor: String(offset + 1000) } : {} }) };
		}
		if (path.endsWith('/query') && typeof request.body === 'string') {
			const { sql, params } = JSON.parse(request.body) as { sql: string; params?: string[] };
			const fenced = (path.includes(replacementId) ? replacementFence : fence).query(sql, params);
			if (fenced) return json(fenced);
			if (path.includes(replacementId)) {
				if (sql === 'fresh-schema') initialized = true;
				return json([{ results: sql.includes('sqlite_master') ? initialized ? [{ name: 'crate_schema' }] : []
					: sql.startsWith('SELECT version') ? [{ version: SERVER_RELEASE.schemaVersion, created_version: SERVER_RELEASE.schemaVersion }] : [] }]);
			}
			return json([{ results: sql.startsWith('PRAGMA') ? [{ name: 'storage_key' }] : ['files', 'auth_tokens', 'maintenance_state'].map(name => ({ name })) }]);
		}
		throw new Error(`Unexpected request: ${request.method} ${path}`);
	});
	const beforeServerReset = vi.fn(async () => {});
	function createService(send: HttpTransport = transport) {
		const opened: string[] = [];
		const service = new CloudflareDeploymentService({
			clientId: 'd'.repeat(32), settingsOwner: { settings, writeSettings }, transport: send,
			loadArtifacts: async () => ({ version: '0.1.0', fingerprint: 'f'.repeat(64), workerBundle: '', workerBundleSha256: '', d1Schema: 'fresh-schema', d1SchemaSha256: '' }),
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
	return { settings, writeSettings, mutations, objects, remote, transport, beforeServerReset, createService, replacementId, databaseId };
}

const device = { tokenHash: 'hash', deviceId: 'device', deviceName: 'Test', platform: 'desktop' };

describe('Cloudflare deployment interruption and recovery', () => {
	it('deletes an older server with a settled update and clears the saved connection', async () => {
		const h = harness();
		const metadata = h.settings.cloudflareDeployment!;
		metadata.lastKnownRevision = 53;
		await h.transport(`https://api.cloudflare.com/client/v4/accounts/${metadata.accountId}/d1/database/${h.databaseId}/query`, {
			method: 'POST', body: JSON.stringify({
				sql: 'INSERT INTO maintenance_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING RETURNING value;',
				params: ['crate_deployment_fence', JSON.stringify({
					owner: '01234567-89ab-cdef-0123-456789abcdef', worker: metadata.workerName,
					kind: 'update', version: '0.1.0', fingerprint: 'a'.repeat(64), recoveryProtocol: 1,
					step: 'record-release', stepState: 'confirmed', verificationPending: true,
				})],
			}),
		});
		const { service } = h.createService();
		const result = await service.deployWithSavedAuthorization('delete', operation => operation({ accessToken: 'saved' }));
		expect(result.deleted).toBe(true);
		expect(h.settings.cloudflareDeployment).toBeNull();
		expect(h.remote).toEqual({ worker: false, bucket: false, database: false, retired: true });
		expect(h.mutations).not.toContain('create-database');
		expect(h.mutations).not.toContain('create-bucket');
	});

	it.each(['oauth', 'saved'] as const)('rebuilds after reset with %s authorization', async authorization => {
		const h = harness();
		const { service, authorize } = h.createService();
		const result = authorization === 'oauth' ? await service.handleCallback(await authorize('reset'), device)
			: await service.deployWithSavedAuthorization('reset', operation => operation({ accessToken: 'saved' }), device);
		expect(result.workerUrl).toContain('.workers.dev');
		expect(h.settings.cloudflareDeployment).toMatchObject({ d1DatabaseId: h.replacementId, lastKnownRevision: SERVER_RELEASE.revision });
		expect(h.settings.cloudflareDeployment!.reset).toBeUndefined();
		expect(h.mutations.filter(value => value === 'create-database')).toHaveLength(1);
		expect(h.transport.mock.calls.some(([url, request]) => url.includes(h.replacementId) && typeof request.body === 'string' && request.body.includes('INSERT INTO auth_tokens'))).toBe(true);
	});

	it.each(['lost creation response', 'failed checkpoint'] as const)('resumes the replacement database after %s without repeating deletion', async failure => {
		const h = harness();
		let fail = true;
		if (failure === 'failed checkpoint') {
			const save = h.writeSettings.getMockImplementation()!;
			h.writeSettings.mockImplementation(async update => {
				if (fail && update.cloudflareDeployment?.d1DatabaseId === h.replacementId) { fail = false; throw new Error('disk full'); }
				await save(update);
			});
		}
		const first = h.createService(async (url, request) => {
			const response = await h.transport(url, request);
			if (failure === 'lost creation response' && fail && request.method === 'POST' && url.endsWith('/d1/database')) { fail = false; throw new Error('response lost'); }
			return response;
		});
		await expect(first.service.handleCallback(await first.authorize('reset'), device)).rejects.toThrow(failure === 'failed checkpoint' ? 'disk full' : 'response lost');
		expect(h.settings.cloudflareDeployment).toMatchObject({ d1DatabaseId: h.databaseId, reset: { phase: 'rebuilding', databaseId: h.databaseId } });
		expect(h.mutations).not.toContain('create-bucket');
		const deletions = h.transport.mock.calls.filter(([, request]) => request.method === 'DELETE').length;
		const retry = h.createService();
		await retry.service.deployWithSavedAuthorization('reset', operation => operation({ accessToken: 'saved' }), device);
		expect(h.settings.cloudflareDeployment!.d1DatabaseId).toBe(h.replacementId);
		expect(h.settings.cloudflareDeployment!.reset).toBeUndefined();
		expect(h.mutations.filter(value => value === 'create-database')).toHaveLength(1);
		expect(h.transport.mock.calls.filter(([, request]) => request.method === 'DELETE')).toHaveLength(deletions);
	});

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
		const checkpoint = structuredClone(intent === 'delete' ? h.settings.cloudflareDeployment!.deletion : h.settings.cloudflareDeployment!.reset);
		const writes = h.writeSettings.mock.calls.length;
		first.service.destroy();
		release();
		await rejected;
		expect(h.objects.size).toBe(500);
		expect(h.remote).toEqual({ worker: intent === 'reset', bucket: true, database: true, retired: true });
		expect(h.mutations).toHaveLength(intent === 'delete' ? 3 : 2); // Take the server offline, prepare cleanup, and dispatch one batch.
		expect(h.writeSettings).toHaveBeenCalledTimes(writes);
		expect(intent === 'delete' ? h.settings.cloudflareDeployment!.deletion : h.settings.cloudflareDeployment!.reset).toEqual(checkpoint);
		expect(checkpoint?.phase).toBe(intent === 'delete' ? 'clearing-bucket' : 'clearing');
		expect(vi.mocked(h.transport).mock.calls.at(-1)?.[0]).toContain('/oauth2/revoke');

		if (intent === 'delete') {
			const retry = h.createService();
			const result = await retry.service.handleCallback(await retry.authorize('delete'));
			expect(result.deleted).toBe(true);
			expect(h.settings.cloudflareDeployment).toBeNull();
			expect(h.remote).toEqual({ worker: false, bucket: false, database: false, retired: true });
			expect(h.objects.size).toBe(0);
			// No repeated Worker retirement, object deletion or database deletion.
			expect(h.mutations).toHaveLength(8);
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

it('keeps cleanup capability rejection distinct from account OAuth and allows deletion retry', async () => {
	const h = harness();
	let rejectCleanup = true;
	const { service } = h.createService(async (url, request) => {
		if (rejectCleanup && url.endsWith('/__crate__/reset/objects')) return { status: 403, text: 'Object not owned' };
		return h.transport(url, request);
	});
	const authorize = <T>(operation: (tokens: { accessToken: string }) => Promise<T>) => operation({ accessToken: 'saved' });
	await expect(service.deployWithSavedAuthorization('delete', authorize)).rejects.toThrow('Remote file cleanup failed with HTTP 403');
	expect(h.remote).toMatchObject({ worker: false, database: true, bucket: true });
	rejectCleanup = false;
	await expect(service.deployWithSavedAuthorization('delete', authorize)).resolves.toMatchObject({ deleted: true });
});

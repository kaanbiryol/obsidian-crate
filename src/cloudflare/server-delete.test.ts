import { describe, expect, it, vi } from 'vitest';
import { CloudflareApiError, type CloudflareWorkerSettings, type DurableObjectNamespace } from './cloudflare-api';
import type { CloudflareDeploymentMetadata } from './deployment-types';
import { DEPLOYMENT_FENCE_KEY } from './deployment-fence';
import { createFenceQueryHarness } from './deployment-fence-test-harness';
import { deleteCrateServer } from './server-delete';

function harness() {
	const fence = createFenceQueryHarness();
	const name = 'crate-0123456789abcdef', accountId = 'a'.repeat(32), databaseId = '01234567-89ab-cdef-0123-456789abcdef';
	const metadata: CloudflareDeploymentMetadata = { deploymentId: '0123456789abcdef', accountId, accountName: 'Personal',
		workerName: name, d1DatabaseName: name, d1DatabaseId: databaseId, r2BucketName: name,
		workersSubdomain: 'example', lastDeployedVersion: 'unrecognized-development-version', lastDeployedFingerprint: null, lastKnownRevision: 99999 };
	const worker: CloudflareWorkerSettings = { annotations: { 'workers/message': 'Crate unknown build' }, bindings: [
		{ type: 'd1', name: 'FUTURE_DB', id: databaseId }, { type: 'r2_bucket', name: 'OLD_FILES', bucket_name: name },
		{ type: 'plain_text', name: 'PROTOCOL_VERSION', text: '999' }, { type: 'queue', name: 'UNRECOGNIZED_BINDING' },
	] };
	const workers = new Map<string, { settings: CloudflareWorkerSettings; created_on: string }>([
		[name, { settings: worker, created_on: '2026-01-01' }], ['unrelated', { settings: { bindings: [] }, created_on: '2026-01-02' }],
	]);
	const remote = { database: true, bucket: true, bucketCreatedAt: '2026-01-01' };
	const namespaces: DurableObjectNamespace[] = [{ id: 'b'.repeat(32), script: name, class: 'OldReminderClass' },
		{ id: 'c'.repeat(32), script: name, class: 'FutureSafetyClass' }, { id: 'd'.repeat(32), script: 'unrelated', class: 'Keep' }];
	const objects = new Set(['old-file.md', 'future/data.v999', '__crate__/backups/unknown/data', '../opaque-key']);
	const events: string[] = [];
	const api = {
		listWorkers: vi.fn(async () => [...workers].map(([id, value]) => ({ id, created_on: value.created_on }))),
		getWorkerSettings: vi.fn(async (_account: string, target: string) => {
			const current = workers.get(target);
			if (!current) throw new CloudflareApiError('Missing Worker', 404, null);
			return current.settings;
		}),
		getD1Database: vi.fn(async () => remote.database ? { uuid: databaseId, name } : null),
		getR2Bucket: vi.fn(async () => remote.bucket ? { name, creation_date: remote.bucketCreatedAt } : null),
		listDurableObjectNamespaces: vi.fn(async () => namespaces),
		queryD1: vi.fn(async (_account: string, _database: string, sql: string, params?: string[]) => {
			const results = fence.query(sql, params);
			if (!results) throw new Error(`Deletion must not query application schemas or data: ${sql}`);
			return results;
		}),
		deleteWorker: vi.fn(async (_account: string, target: string) => {
			events.push(`worker:${target}`); workers.delete(target);
			for (let i = namespaces.length - 1; i >= 0; i--) if (namespaces[i]!.script === target) namespaces.splice(i, 1);
		}),
		uploadServerDeletionWorker: vi.fn(async (_account: string, target: string, id: string, bucket: string, hash: string, tag: string) => {
			events.push('helper');
			workers.set(target, { created_on: '2026-09-29', settings: { annotations: { 'workers/message': `Crate deletion ${id}`, 'workers/tag': tag },
				bindings: [{ type: 'r2_bucket', name: 'BUCKET', bucket_name: bucket }, { type: 'plain_text', name: 'CRATE_RESET_ID', text: id },
					{ type: 'plain_text', name: 'CRATE_DELETE_TOKEN_HASH', text: hash }, { type: 'plain_text', name: 'CRATE_DELETE_UPLOAD_TAG', text: tag }] } });
		}),
		enableWorkerSubdomain: vi.fn(async () => {}), getWorkersSubdomain: vi.fn(async () => 'example'), verifyResetWorker: vi.fn(async () => true),
		listR2Objects: vi.fn(async () => ({ keys: [...objects].slice(0, 1000), ...(objects.size > 1000 ? { cursor: 'more' } : {}) })),
		deleteR2Objects: vi.fn(async (_origin: string, _id: string, _token: string, keys: string[]) => {
			events.push('objects'); keys.forEach(key => objects.delete(key));
		}),
		deleteR2Bucket: vi.fn(async () => { events.push('bucket'); remote.bucket = false; }),
		deleteD1Database: vi.fn(async () => { events.push('database'); remote.database = false; }),
	};
	const input = { api, accountId, metadata, beforeDelete: vi.fn(async () => { events.push('shutdown'); }),
		persist: vi.fn(async () => { events.push(`save:${metadata.deletion?.phase}`); }) };
	const record = () => JSON.parse(fence.query('SELECT value FROM maintenance_state WHERE key = ?;', [DEPLOYMENT_FENCE_KEY])![0]!.results[0]!.value as string) as Record<string, unknown>;
	const hold = (overrides: Record<string, unknown>) => fence.query('INSERT INTO maintenance_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING RETURNING value;',
		[DEPLOYMENT_FENCE_KEY, JSON.stringify({ owner: crypto.randomUUID(), worker: name, kind: 'update', version: '999.0.0', ...overrides })]);
	return { input, api, metadata, remote, workers, worker, namespaces, objects, events, record, hold, fence };
}

describe('terminal server deletion', () => {
	it.each([1, 10, 999])('removes the whole selected server regardless of protocol %s or unknown data formats', async protocol => {
		const h = harness();
		h.worker.bindings!.find(binding => binding.name === 'PROTOCOL_VERSION')!.text = String(protocol);
		await deleteCrateServer(h.input);
		expect(h.remote.database).toBe(false); expect(h.remote.bucket).toBe(false); expect(h.objects.size).toBe(0);
		expect([...h.workers.keys()]).toEqual(['unrelated']);
		expect(h.namespaces).toEqual([{ id: 'd'.repeat(32), script: 'unrelated', class: 'Keep' }]);
		expect(h.metadata.deletion?.phase).toBe('complete');
		expect(h.events.indexOf('shutdown')).toBeLessThan(h.events.indexOf(`worker:${h.metadata.workerName}`));
		expect(h.events.indexOf(`worker:${h.metadata.workerName}`)).toBeLessThan(h.events.indexOf('objects'));
		expect(h.events.indexOf('bucket')).toBeLessThan(h.events.indexOf('database'));
		expect(h.api.uploadServerDeletionWorker.mock.calls.every(call => call[1] !== h.metadata.workerName)).toBe(true);
	});

	it.each(['confirmed', 'rejected', 'settled'])('supersedes any %s administrative step without release or step allowlists', async stepState => {
		const h = harness();
		h.hold({ step: 'unknown-future-step', stepState, kind: 'future-operation', recoveryProtocol: 999, verificationPending: true });
		await deleteCrateServer(h.input);
		expect(h.objects.size).toBe(0);
	});

	it.each(['started', undefined])('does not overlap an unresolved provider mutation (%s)', async stepState => {
		const h = harness(); h.hold({ step: 'upload-worker', stepState });
		await expect(deleteCrateServer(h.input)).rejects.toThrow('may still be running');
		expect(h.api.deleteWorker).not.toHaveBeenCalled(); expect(h.api.deleteR2Objects).not.toHaveBeenCalled();
	});

	it('includes only non-secret operation fields in deletion recovery diagnostics', async () => {
		const h = harness(); h.hold({ step: 'upload-worker', stepState: 'started', secret: 'never-display-this' });
		const rejection = deleteCrateServer(h.input);
		await expect(rejection).rejects.toThrow('"step": "upload-worker"');
		await expect(rejection).rejects.not.toThrow('never-display-this');
	});

	it('uses compare-and-swap when a settled predecessor changes before deletion takes ownership', async () => {
		const h = harness(); h.hold({ stepState: 'confirmed' });
		const query = h.api.queryD1.getMockImplementation()!;
		h.api.queryD1.mockImplementation(async (account, database, sql, params) => {
			if (sql.startsWith('UPDATE maintenance_state')) { h.fence.clear(); h.hold({ stepState: 'started' }); }
			return query(account, database, sql, params);
		});
		await expect(deleteCrateServer(h.input)).rejects.toThrow('Another deployment');
		expect(h.api.deleteWorker).not.toHaveBeenCalled();
	});

	it.each(['shutdown', 'save'] as const)('makes no destructive requests when local %s fails', async failure => {
		const h = harness();
		if (failure === 'shutdown') h.input.beforeDelete.mockRejectedValueOnce(new Error('shutdown failed'));
		else h.input.persist.mockRejectedValueOnce(new Error('disk full'));
		await expect(deleteCrateServer(h.input)).rejects.toThrow(failure === 'shutdown' ? 'shutdown failed' : 'disk full');
		expect(h.api.deleteWorker).not.toHaveBeenCalled();
		await deleteCrateServer(h.input);
		expect(h.remote.database).toBe(false);
	});

	it.each(['deleteWorker', 'uploadServerDeletionWorker', 'deleteR2Bucket', 'deleteD1Database'] as const)('holds deletion after a definite %s rejection and retries', async step => {
		const h = harness(); h.api[step].mockRejectedValueOnce(new CloudflareApiError('Permission denied', 403, null));
		await expect(deleteCrateServer(h.input)).rejects.toThrow('Permission denied');
		expect(h.record()).toMatchObject({ kind: 'delete', deletionPending: true, stepState: 'rejected' });
		await deleteCrateServer(h.input); expect(h.metadata.deletion?.phase).toBe('complete');
	});

	it.each(['deleteWorker', 'deleteR2Objects', 'deleteR2Bucket', 'deleteD1Database'] as const)('resumes a lost %s response after its destructive request was applied', async step => {
		const h = harness(); const apply = h.api[step].getMockImplementation()!;
		// Each method has different arguments; preserve its actual call through Reflect.
		h.api[step].mockImplementationOnce(async (...args: unknown[]) => { await Reflect.apply(apply, undefined, args); throw new Error('response lost'); });
		await expect(deleteCrateServer(h.input)).rejects.toThrow('response lost');
		await deleteCrateServer(h.input); expect(h.metadata.deletion?.phase).toBe('complete');
		expect(h.events.filter(event => event === 'database')).toHaveLength(1);
	});

	it.each([false, true])('re-lists only remaining objects after a partially applied batch (applied=%s)', async applied => {
		const h = harness(); h.objects.clear();
		for (let i = 0; i < 2100; i++) h.objects.add(`arbitrary-${i}`);
		let batches = 0;
		h.api.deleteR2Objects.mockImplementation(async (_origin, _id, _token, keys) => {
			if (++batches === 2) { if (applied) keys.slice(0, 90).forEach(key => h.objects.delete(key)); throw new Error('response lost'); }
			keys.forEach(key => h.objects.delete(key));
		});
		await expect(deleteCrateServer(h.input)).rejects.toThrow('response lost');
		const remaining = [...h.objects], oldToken = h.api.deleteR2Objects.mock.calls[0]![2];
		h.api.deleteR2Objects.mockClear();
		await deleteCrateServer(h.input);
		expect(h.api.deleteR2Objects.mock.calls.flatMap(call => call[3])).toEqual(remaining);
		expect(h.api.deleteR2Objects.mock.calls[0]![2]).not.toBe(oldToken);
	});

	it('prevents an earlier deletion from dispatching more steps after a resume takes ownership', async () => {
		const h = harness(); h.objects.clear();
		for (let i = 0; i < 1500; i++) h.objects.add(`key-${i}`);
		let release!: () => void, dispatched = false;
		const pending = new Promise<void>(resolve => { release = resolve; });
		h.api.deleteR2Objects.mockImplementationOnce(async (_origin, _id, _token, keys) => {
			keys.forEach(key => h.objects.delete(key)); dispatched = true; await pending;
		});
		const original = deleteCrateServer(h.input);
		const rejection = expect(original).rejects.toThrow('checkpoint');
		await vi.waitFor(() => expect(dispatched).toBe(true));
		await deleteCrateServer(h.input);
		release(); await rejection;
		expect(h.api.deleteR2Objects).toHaveBeenCalledTimes(2);
		expect(h.api.deleteR2Bucket).toHaveBeenCalledOnce();
		expect(h.api.deleteD1Database).toHaveBeenCalledOnce();
	});

	it('clears 7,992 arbitrary objects in eight native bulk requests', async () => {
		const h = harness(); h.objects.clear();
		for (let i = 0; i < 7992; i++) h.objects.add(`unrecognized/${i}`);
		await deleteCrateServer(h.input);
		expect(h.api.deleteR2Objects).toHaveBeenCalledTimes(8);
	});

	it('bounds serialized batches even when opaque keys expand while JSON encoding', async () => {
		const h = harness(); h.objects.clear();
		for (let i = 0; i < 1000; i++) h.objects.add(`${i}-${'\u0000'.repeat(1018)}`);
		await deleteCrateServer(h.input);
		const batches = h.api.deleteR2Objects.mock.calls.map(call => call[3]);
		expect(batches.flat()).toHaveLength(1000);
		for (const keys of batches) expect(new TextEncoder().encode(JSON.stringify(keys)).length).toBeLessThanOrEqual(1_100_000);
	});

	it.each(['worker', 'database', 'bucket', 'all'] as const)('finishes deletion when %s resources are already missing', async missing => {
		const h = harness();
		if (missing === 'worker' || missing === 'all') { h.workers.delete(h.metadata.workerName); h.namespaces.splice(0, 2); }
		if (missing === 'database' || missing === 'all') h.remote.database = false;
		if (missing === 'bucket' || missing === 'all') h.remote.bucket = false;
		await deleteCrateServer(h.input); expect(h.metadata.deletion?.phase).toBe('complete');
		if (missing === 'database' || missing === 'all') expect(h.api.queryD1).not.toHaveBeenCalled();
	});

	it.each([false, true])('checks the upload receipt after a lost helper publication (applied=%s)', async applied => {
		const h = harness(), upload = h.api.uploadServerDeletionWorker.getMockImplementation()!;
		h.api.uploadServerDeletionWorker.mockImplementationOnce(async (...args) => { if (applied) await upload(...args); throw new Error('upload lost'); });
		await expect(deleteCrateServer(h.input)).rejects.toThrow('upload lost');
		if (applied) { await deleteCrateServer(h.input); expect(h.remote.database).toBe(false); }
		else {
			await expect(deleteCrateServer(h.input)).rejects.toThrow('may still be running');
			expect(h.api.uploadServerDeletionWorker).toHaveBeenCalledOnce();
		}
	});

	it.each([false, true])('persists helper upload uncertainty even when the database is absent (applied=%s)', async applied => {
		const h = harness(); h.remote.database = false;
		const upload = h.api.uploadServerDeletionWorker.getMockImplementation()!;
		h.api.uploadServerDeletionWorker.mockImplementationOnce(async (...args) => { if (applied) await upload(...args); throw new Error('upload lost'); });
		await expect(deleteCrateServer(h.input)).rejects.toThrow('upload lost');
		expect(h.metadata.deletion?.helperUploadPending).toMatch(/^crate-/);
		if (applied) { await deleteCrateServer(h.input); expect(h.metadata.deletion?.phase).toBe('complete'); }
		else await expect(deleteCrateServer(h.input)).rejects.toThrow('uncertain outcome');
	});

	it('does not publish a helper after its local dispatch checkpoint failed', async () => {
		const h = harness(); h.remote.database = false;
		let fail = true;
		h.input.persist.mockImplementation(async () => {
			if (h.metadata.deletion?.helperUploadPending && fail) { fail = false; throw new Error('disk full'); }
		});
		await expect(deleteCrateServer(h.input)).rejects.toThrow('disk full');
		expect(h.api.uploadServerDeletionWorker).not.toHaveBeenCalled();
		await deleteCrateServer(h.input); expect(h.metadata.deletion?.phase).toBe('complete');
	});

	it.each(['bucket', 'worker', 'helper'] as const)('does not remove a replacement %s during retry', async target => {
		const h = harness(); h.api.deleteR2Objects.mockRejectedValueOnce(new Error('connection lost'));
		await expect(deleteCrateServer(h.input)).rejects.toThrow('connection lost');
		if (target === 'bucket') h.remote.bucketCreatedAt = 'replacement';
		if (target === 'worker') h.workers.set(h.metadata.workerName, { created_on: 'replacement', settings: h.worker });
		if (target === 'helper') h.workers.get(h.metadata.deletion!.helperName)!.settings.annotations = { 'workers/message': 'Other application' };
		const deletions = h.api.deleteWorker.mock.calls.length;
		await expect(deleteCrateServer(h.input)).rejects.toThrow(target === 'helper' ? 'cleanup Worker changed' : 'recreated');
		expect(h.api.deleteWorker).toHaveBeenCalledTimes(deletions);
	});

	it.each(['d1', 'r2_bucket', 'durable_object_namespace', 'service'])('blocks a shared %s resource before deletion', async type => {
		const h = harness(); h.workers.get('unrelated')!.settings.bindings = [{ type, id: h.metadata.d1DatabaseId!, bucket_name: h.metadata.r2BucketName,
			namespace_id: h.namespaces[0]!.id, service: h.metadata.workerName }];
		await expect(deleteCrateServer(h.input)).rejects.toThrow('shares'); expect(h.api.deleteWorker).not.toHaveBeenCalled();
	});

	it('resumes a legacy delete-only retirement checkpoint', async () => {
		const h = harness();
		h.metadata.reset = { id: 'e'.repeat(32), phase: 'clearing', deleteOnly: true, databaseId: h.metadata.d1DatabaseId!, bucketCreatedAt: h.remote.bucketCreatedAt, namespaceId: 'b'.repeat(32) };
		h.worker.annotations = { 'workers/message': `Crate reset ${h.metadata.reset.id}` };
		h.hold({ kind: 'delete', resetId: h.metadata.reset.id, step: 'deleteR2Objects', stepState: 'started', recoveryProtocol: 1 });
		await deleteCrateServer(h.input); expect(h.metadata.deletion?.id).toBe(h.metadata.reset.id);
	});

	it('can terminally delete a settled interrupted reset without rebuilding it', async () => {
		const h = harness();
		h.metadata.reset = { id: 'e'.repeat(32), phase: 'clearing', databaseId: h.metadata.d1DatabaseId!, bucketCreatedAt: h.remote.bucketCreatedAt, namespaceId: 'b'.repeat(32) };
		h.hold({ kind: 'reset', resetId: h.metadata.reset.id, step: 'future-step', stepState: 'confirmed' });
		await deleteCrateServer(h.input); expect(h.metadata.deletion?.phase).toBe('complete');
	});

	it('can retry after the database was deleted but progress could not be saved', async () => {
		const h = harness(); h.input.persist.mockImplementationOnce(async () => {});
		const persist = h.input.persist.getMockImplementation()!;
		h.input.persist.mockImplementation(async () => { if (h.metadata.deletion?.phase === 'removing-helper') throw new Error('disk full'); await persist(); });
		await expect(deleteCrateServer(h.input)).rejects.toThrow('disk full');
		h.input.persist.mockResolvedValue(); await deleteCrateServer(h.input);
		expect(h.api.deleteD1Database).toHaveBeenCalledOnce(); expect(h.metadata.deletion?.phase).toBe('complete');
	});
});

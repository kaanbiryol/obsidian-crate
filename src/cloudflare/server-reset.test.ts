import { describe, expect, it, vi } from 'vitest';
import { deleteCrateServer } from './server-delete';
import { resetCrateServer } from './server-reset';
import type { CloudflareDeploymentMetadata } from './deployment-types';
import type { CloudflareWorkerSettings } from './cloudflare-api';
import { createFenceQueryHarness } from './deployment-fence-test-harness';

function harness() {
	const fence = createFenceQueryHarness();
	const metadata: CloudflareDeploymentMetadata = {
		deploymentId: '0123456789abcdef', accountId: 'a'.repeat(32), accountName: 'Personal',
		workerName: 'crate-0123456789abcdef', d1DatabaseName: 'crate-0123456789abcdef',
		d1DatabaseId: '01234567-89ab-cdef-0123-456789abcdef', r2BucketName: 'crate-0123456789abcdef',
		workersSubdomain: 'example', lastDeployedVersion: '0.1.0', lastDeployedFingerprint: null,
	};
	const worker: CloudflareWorkerSettings = {
		annotations: { 'workers/message': 'Crate 0.1.0' },
		bindings: [
			{ type: 'd1', name: 'DB', id: metadata.d1DatabaseId! },
			{ type: 'r2_bucket', name: 'BUCKET', bucket_name: metadata.r2BucketName },
			{ type: 'durable_object_namespace', name: 'REMINDER_ALARMS', class_name: 'ReminderAlarm', namespace_id: 'c'.repeat(32) },
		],
	};
	let bucket: { name: string; creation_date: string } | null = { name: metadata.r2BucketName, creation_date: '2026-01-01T00:00:00Z' };
	let database: { uuid: string; name: string } | null = { uuid: metadata.d1DatabaseId!, name: metadata.d1DatabaseName };
	const objects = new Set(['__crate__/settings.json']);
	const api = {
		deleteWorker: vi.fn(async () => {}),
		getWorkerSettings: vi.fn(async (_account: string, _name: string) => worker),
		listWorkers: vi.fn(async () => [{ id: metadata.workerName }]),
		getD1Database: vi.fn(async () => database),
		getR2Bucket: vi.fn(async () => bucket),
		listDurableObjectNamespaces: vi.fn(async () => worker.bindings?.some(binding => binding.type === 'durable_object_namespace') ? [{ id: 'c'.repeat(32), script: metadata.workerName, class: 'ReminderAlarm' }] : []),
		queryD1: vi.fn(async (_account: string, _db: string, sql: string, params?: string[]): Promise<Array<{ results: Array<Record<string, unknown>> }>> => fence.query(sql, params) ?? [{ results: sql.startsWith('PRAGMA')
			? [{ name: 'storage_key' }] : ['files', 'auth_tokens', 'crate_migrations'].map(name => ({ name })) }]),
		listR2Objects: vi.fn(async (_account: string, _bucket: string, cursor?: string): Promise<{ keys: string[]; cursor?: string }> => {
			const offset = Number(cursor ?? 0);
			return { keys: [...objects].slice(offset, offset + 1000), ...(offset + 1000 < objects.size ? { cursor: String(offset + 1000) } : {}) };
		}),
		deleteR2Objects: vi.fn(async (_origin: string, _reset: string, _token: string, keys: string[]) => { keys.forEach(key => objects.delete(key)); }),
		verifyResetWorker: vi.fn(async () => {}),
		getWorkersSubdomain: vi.fn(async () => 'example'),
		deleteR2Bucket: vi.fn(async () => { bucket = null; }),
		deleteD1Database: vi.fn(async () => { database = null; }),
		retireCrateWorker: vi.fn(async (_account: string, _worker: string, resetId: string) => {
			worker.annotations = { 'workers/message': `Crate reset ${resetId}`, 'workers/tag': 'crate' };
			worker.bindings = [...worker.bindings!.filter(binding => ['d1', 'r2_bucket'].includes(binding.type!)), { type: 'plain_text', name: 'CRATE_RESET_ID', text: resetId }];
		}),
	};
	const input = { api, metadata, accountId: metadata.accountId!, version: '0.1.0', beforeDelete: vi.fn(async () => {}), persist: vi.fn(async () => {}) };
	return { input, worker, api, metadata, objects, clearFence: fence.clear };
}

describe('Crate server reset boundaries', () => {
	it('deletes only the exact verified database after stopping local sync', async () => {
		const { input, api, metadata } = harness();
		await resetCrateServer(input);
		expect(api.deleteD1Database).toHaveBeenCalledExactlyOnceWith(metadata.accountId, metadata.d1DatabaseId);
		expect(input.beforeDelete.mock.invocationCallOrder[0]).toBeLessThan(api.deleteD1Database.mock.invocationCallOrder[0]!);
		expect(api.retireCrateWorker).toHaveBeenCalledOnce();
		expect(api.deleteR2Objects).toHaveBeenCalledExactlyOnceWith(`https://${metadata.workerName}.example.workers.dev`, metadata.reset!.id, expect.stringMatching(/^[a-f0-9]{64}$/), ['__crate__/settings.json']);
		expect(api.deleteR2Bucket).toHaveBeenCalledExactlyOnceWith(metadata.accountId, metadata.r2BucketName);
		expect(metadata.reset?.phase).toBe('rebuilding');
	});

	it.each([
		['wrong account', (h: ReturnType<typeof harness>) => { h.input.accountId = 'b'.repeat(32); }],
		['other database name', (h: ReturnType<typeof harness>) => { h.metadata.d1DatabaseName = 'customer-data'; }],
		['other Worker', (h: ReturnType<typeof harness>) => { h.metadata.workerName = 'customer-api'; }],
		['other bucket', (h: ReturnType<typeof harness>) => { h.metadata.r2BucketName = 'customer-files'; }],
		['unrelated bucket object', (h: ReturnType<typeof harness>) => { h.objects.add('personal-photo.jpg'); }],
		['missing Crate annotation', (h: ReturnType<typeof harness>) => { h.worker.annotations = {}; }],
		['unexpected Worker binding', (h: ReturnType<typeof harness>) => { h.worker.bindings!.push({ type: 'kv_namespace', name: 'CUSTOM', id: 'unrelated' }); }],
		['changed live binding', (h: ReturnType<typeof harness>) => { h.worker.bindings![0]!.id = 'another-database'; }],
		['renamed live database', (h: ReturnType<typeof harness>) => { h.api.getD1Database.mockResolvedValue({ uuid: h.metadata.d1DatabaseId!, name: 'customer-data' }); }],
		['unknown tables', (h: ReturnType<typeof harness>) => { h.api.queryD1.mockResolvedValue([{ results: ['files', 'auth_tokens', 'customers'].map(name => ({ name })) }]); }],
		['empty schema', (h: ReturnType<typeof harness>) => { h.api.queryD1.mockResolvedValue([{ results: [] }]); }],
		['newer server', (h: ReturnType<typeof harness>) => { h.worker.annotations = { 'workers/message': 'Crate 9.0.0' }; }],
		['shared database', (h: ReturnType<typeof harness>) => { h.api.listWorkers.mockResolvedValue([{ id: h.metadata.workerName }, { id: 'unrelated-app' }]); }],
		['unreadable Worker', (h: ReturnType<typeof harness>) => { h.api.getWorkerSettings.mockRejectedValue(new Error('Forbidden')); }],
	] as const)('refuses %s without deleting or disconnecting', async (_name, mutate) => {
		const h = harness();
		mutate(h);
		await expect(resetCrateServer(h.input)).rejects.toThrow();
		expect(h.api.deleteD1Database).not.toHaveBeenCalled();
		expect(h.api.deleteR2Objects).not.toHaveBeenCalled();
		expect(h.api.deleteR2Bucket).not.toHaveBeenCalled();
		expect(h.api.retireCrateWorker).not.toHaveBeenCalled();
		expect(h.input.beforeDelete).not.toHaveBeenCalled();
	});

	it('does not delete when bindings change during sync shutdown', async () => {
		const { input, api, worker } = harness();
		input.beforeDelete.mockImplementation(async () => { worker.bindings![0]!.id = 'other'; });
		await expect(resetCrateServer(input)).rejects.toThrow('bindings do not match');
		expect(api.deleteD1Database).not.toHaveBeenCalled();
	});

	it('does not delete when sync shutdown fails', async () => {
		const { input, api } = harness();
		input.beforeDelete.mockRejectedValue(new Error('disk full'));
		await expect(resetCrateServer(input)).rejects.toThrow('disk full');
		expect(api.deleteD1Database).not.toHaveBeenCalled();
	});

	it('accepts the fingerprint and public origin bindings on a current deployment', async () => {
		const h = harness();
		h.worker.bindings!.push({ type: 'plain_text', name: 'CRATE_VAULT_NAME', text: 'Notes' }, { type: 'plain_text', name: 'CRATE_DEPLOYMENT_FINGERPRINT', text: 'f'.repeat(64) },
			{ type: 'plain_text', name: 'CRATE_PUBLIC_ORIGIN', text: `https://${h.metadata.workerName}.example.workers.dev` });
		await deleteCrateServer(h.input);
		expect(h.api.deleteWorker).toHaveBeenCalledOnce();
	});

	it('preserves files when the cleanup Worker is not ready and can retry without repeating retirement', async () => {
		const h = harness();
		h.api.verifyResetWorker.mockRejectedValueOnce(new Error('cleanup not ready'));
		await expect(deleteCrateServer(h.input)).rejects.toThrow('cleanup not ready');
		expect(h.objects.size).toBe(1);
		expect(h.api.deleteR2Objects).not.toHaveBeenCalled();
		await deleteCrateServer(h.input);
		expect(h.api.retireCrateWorker).toHaveBeenCalledOnce();
		expect(h.api.deleteR2Objects).toHaveBeenCalledOnce();
	});

	it('upgrades an old retirement stub under the fence before continuing deletion', async () => {
		const h = harness();
		h.api.deleteR2Objects.mockRejectedValueOnce(new Error('offline'));
		await expect(deleteCrateServer(h.input)).rejects.toThrow('uncertain outcome');
		h.worker.bindings = h.worker.bindings!.filter(binding => binding.name !== 'CRATE_RESET_ID');
		const [row] = await h.api.queryD1(h.metadata.accountId!, h.metadata.d1DatabaseId!, 'SELECT value FROM maintenance_state WHERE key = ?;', ['crate_deployment_fence']);
		const previous = row!.results[0]!.value as string;
		const legacy = { ...JSON.parse(previous), step: 'deleteR2Object' } as Record<string, unknown>;
		delete legacy.resetId;
		delete legacy.cleanupTokenHash;
		delete legacy.batchHash;
		await h.api.queryD1(h.metadata.accountId!, h.metadata.d1DatabaseId!, 'UPDATE maintenance_state SET value = ? WHERE key = ? AND value = ? RETURNING value;', [JSON.stringify(legacy), 'crate_deployment_fence', previous]);
		await deleteCrateServer(h.input);
		expect(h.api.retireCrateWorker).toHaveBeenCalledTimes(2);
		expect(h.api.retireCrateWorker).toHaveBeenLastCalledWith(h.metadata.accountId, h.metadata.workerName, h.metadata.reset!.id, h.metadata.d1DatabaseId, h.metadata.r2BucketName, true);
		expect(h.objects.size).toBe(0);
	});

	it('allows unrelated Workers with separate databases', async () => {
		const { input, api, worker, metadata } = harness();
		api.listWorkers.mockResolvedValue([{ id: metadata.workerName }, { id: 'other-app' }]);
		api.getWorkerSettings.mockImplementation(async (_account, name) => name === metadata.workerName ? worker : { bindings: [{ type: 'd1', name: 'DB', id: 'other' }] });
		await resetCrateServer(input);
		expect(api.deleteD1Database).toHaveBeenCalledExactlyOnceWith(metadata.accountId, metadata.d1DatabaseId);
	});
	it.each(['bucket', 'namespace', 'service'])('blocks a shared %s before any destructive request', async type => {
		const { input, api, worker, metadata } = harness();
		api.listWorkers.mockResolvedValue([{ id: metadata.workerName }, { id: 'other-app' }]);
		const binding = type === 'bucket' ? { type: 'r2_bucket', bucket_name: metadata.r2BucketName }
			: type === 'namespace' ? { type: 'durable_object_namespace', namespace_id: 'c'.repeat(32) }
			: { type: 'service', service: metadata.workerName };
		api.getWorkerSettings.mockImplementation(async (_account, name) => name === metadata.workerName ? worker : { bindings: [binding] });
		await expect(resetCrateServer(input)).rejects.toThrow('another Worker');
		expect(api.retireCrateWorker).not.toHaveBeenCalled();
		expect(api.deleteR2Objects).not.toHaveBeenCalled();
	});

	it('blocks an additional non-Crate Durable Object class owned by the same Worker', async () => {
		const { input, api, metadata } = harness();
		api.listDurableObjectNamespaces.mockResolvedValue([
			{ id: 'c'.repeat(32), script: metadata.workerName, class: 'ReminderAlarm' },
			{ id: 'd'.repeat(32), script: metadata.workerName, class: 'CustomerData' },
		]);
		await expect(resetCrateServer(input)).rejects.toThrow('unexpected Durable Object');
		expect(api.retireCrateWorker).not.toHaveBeenCalled();
	});

	it('inspects every R2 page before deletion, including unrecognized files on later pages', async () => {
		const { input, api } = harness();
		api.listR2Objects.mockResolvedValueOnce({ keys: ['__crate__/settings.json'], cursor: 'next' })
			.mockResolvedValueOnce({ keys: ['private-photo.jpg'] });
		await expect(resetCrateServer(input)).rejects.toThrow('private-photo.jpg');
		expect(api.retireCrateWorker).not.toHaveBeenCalled();
		expect(api.deleteR2Objects).not.toHaveBeenCalled();
	});

	it('resumes a partially cleared bucket without repeating Durable Object deletion', async () => {
		const { input, api, metadata, objects, clearFence } = harness();
		const key = `__crate__/files/${'a'.repeat(64)}/01234567-89ab-cdef-0123-456789abcdef`;
		objects.add(key);
		api.deleteR2Objects.mockImplementationOnce(async (_origin, _reset, _token, keys) => { objects.delete(keys[0]!); throw new Error('temporary network error'); });
		await expect(resetCrateServer(input)).rejects.toThrow('temporary network error');
		expect(metadata.reset?.phase).toBe('clearing');
		expect(api.deleteD1Database).not.toHaveBeenCalled();
		clearFence(); // Explicit recovery after the abandoned request has settled.
		await resetCrateServer(input);
		expect(objects.size).toBe(0);
		expect(api.retireCrateWorker).toHaveBeenCalledOnce();
		expect(metadata.reset?.phase).toBe('rebuilding');
		const deletionCount = api.deleteR2Objects.mock.calls.length;
		await resetCrateServer(input);
		expect(api.deleteR2Objects).toHaveBeenCalledTimes(deletionCount);
		expect(api.deleteD1Database).toHaveBeenCalledOnce();
	});

	it('can resume after database deletion succeeded but the final checkpoint save failed', async () => {
		const { input, metadata, api } = harness();
		let saved: typeof metadata.reset;
		input.persist.mockImplementation(async () => {
			if (metadata.reset?.phase === 'rebuilding') throw new Error('disk full');
			saved = { ...metadata.reset! };
		});
		await expect(resetCrateServer(input)).rejects.toThrow('disk full');
		metadata.reset = saved;
		input.persist.mockResolvedValue();
		await resetCrateServer(input);
		expect(api.deleteD1Database).toHaveBeenCalledOnce();
		expect(api.deleteR2Bucket).toHaveBeenCalledOnce();
		expect(metadata.reset?.phase).toBe('rebuilding');
	});

	it('will not resume deletion against a recreated bucket with the same name', async () => {
		const { input, api, metadata } = harness();
		api.deleteR2Objects.mockRejectedValueOnce(new Error('offline'));
		await expect(resetCrateServer(input)).rejects.toThrow('offline');
		api.getR2Bucket.mockResolvedValue({ name: metadata.r2BucketName, creation_date: 'different-creation-date' });
		await expect(resetCrateServer(input)).rejects.toThrow('bucket identity changed');
		expect(api.deleteR2Objects).toHaveBeenCalledOnce();
		expect(api.deleteD1Database).not.toHaveBeenCalled();
	});

	it('persists the reset identity before retiring the Worker', async () => {
		const { input, api } = harness();
		input.persist.mockRejectedValue(new Error('disk full'));
		await expect(resetCrateServer(input)).rejects.toThrow('disk full');
		expect(api.retireCrateWorker).not.toHaveBeenCalled();
		expect(api.deleteR2Objects).not.toHaveBeenCalled();
	});

});


describe('delete-only server removal', () => {
	it('deletes 7,992 files in eight bulk requests with one pair of checkpoints per batch', async () => {
		const h = harness();
		for (let i = 0; i < 7991; i++) h.objects.add(`__crate__/files/${i.toString(16).padStart(64, '0')}/01234567-89ab-cdef-0123-456789abcdef`);
		await deleteCrateServer(h.input);
		expect(h.api.deleteR2Objects).toHaveBeenCalledTimes(8);
		expect(h.api.deleteR2Objects.mock.calls.map(([, , , keys]) => keys.length)).toEqual([1000, 1000, 1000, 1000, 1000, 1000, 1000, 992]);
		expect(h.objects.size).toBe(0);
		const checkpoints = h.api.queryD1.mock.calls.filter(([, , sql, params]) =>
			sql.startsWith('UPDATE maintenance_state') && params?.[0]?.includes('"step":"deleteR2Objects"'));
		expect(checkpoints).toHaveLength(16);
		for (const [, , , params] of checkpoints) expect(params![0]).not.toContain(h.api.deleteR2Objects.mock.calls[0]![2]);
	});

	it('waits for the active bulk request and leaves later batches untouched on failure', async () => {
		const h = harness();
		for (let i = 0; i < 1499; i++) h.objects.add(`__crate__/files/${i.toString(16).padStart(64, '0')}/01234567-89ab-cdef-0123-456789abcdef`);
		let release!: () => void, started!: () => void;
		const pending = new Promise<void>(resolve => { release = resolve; });
		const dispatched = new Promise<void>(resolve => { started = resolve; });
		h.api.deleteR2Objects.mockImplementation(async (_origin, _reset, _token, keys) => {
			started();
			await pending;
			keys.slice(0, 50).forEach(key => h.objects.delete(key));
			throw new Error('network failed');
		});
		const deletion = deleteCrateServer(h.input);
		const rejected = expect(deletion).rejects.toThrow('uncertain outcome');
		await dispatched;
		expect(h.api.deleteR2Objects).toHaveBeenCalledOnce();
		expect(h.api.deleteR2Bucket).not.toHaveBeenCalled();
		release();
		await rejected;
		expect(h.objects.size).toBe(1450);
		expect(h.api.deleteR2Objects).toHaveBeenCalledOnce();
		expect(h.api.deleteD1Database).not.toHaveBeenCalled();
	});

	it.each([false, true])('resumes an interrupted object deletion, including a lost response (applied=%s)', async applied => {
		const h = harness();
		h.api.deleteR2Objects.mockImplementationOnce(async (_origin, _reset, _token, keys) => {
			if (applied) keys.forEach(key => h.objects.delete(key));
			throw new Error('net::ERR_NETWORK_CHANGED');
		});
		await expect(deleteCrateServer(h.input)).rejects.toThrow('uncertain outcome');
		await deleteCrateServer(h.input);
		expect(h.api.deleteWorker).toHaveBeenCalledOnce();
		expect(h.api.retireCrateWorker).toHaveBeenCalledOnce();
		expect(h.objects.size).toBe(0);
	});

	it('does not let an old deletion continue after another resume takes ownership', async () => {
		const h = harness();
		let release!: () => void;
		let started!: () => void;
		const pending = new Promise<void>(resolve => { release = resolve; });
		const dispatched = new Promise<void>(resolve => { started = resolve; });
		h.api.deleteR2Objects.mockImplementationOnce(async (_origin, _reset, _token, keys) => {
			started();
			await pending;
			keys.forEach(key => h.objects.delete(key));
		});
		const original = deleteCrateServer(h.input);
		const rejected = expect(original).rejects.toThrow('checkpoint');
		await dispatched;
		await deleteCrateServer(h.input);
		release();
		await rejected;
		expect(h.api.deleteR2Bucket).toHaveBeenCalledOnce();
		expect(h.api.deleteD1Database).toHaveBeenCalledOnce();
		expect(h.api.deleteWorker).toHaveBeenCalledOnce();
	});

	it('keeps an uncertain Worker retirement locked', async () => {
		const h = harness();
		const retire = h.api.retireCrateWorker.getMockImplementation()!;
		h.api.retireCrateWorker.mockImplementationOnce(async (...args) => {
			await retire(...args);
			throw new Error('net::ERR_NETWORK_CHANGED');
		});
		await expect(deleteCrateServer(h.input)).rejects.toThrow('uncertain outcome');
		await expect(deleteCrateServer(h.input)).rejects.toThrow('cannot be resumed automatically');
		expect(h.api.deleteR2Objects).not.toHaveBeenCalled();
	});

	it('leaves reset recovery blocked after an uncertain file deletion', async () => {
		const h = harness();
		h.api.deleteR2Objects.mockRejectedValueOnce(new Error('offline'));
		await expect(resetCrateServer(h.input)).rejects.toThrow('uncertain outcome');
		await expect(resetCrateServer(h.input)).rejects.toThrow('Another deployment');
		expect(h.api.deleteR2Objects).toHaveBeenCalledOnce();
	});

	it('does not steal ownership when the inspected record changes', async () => {
		const h = harness();
		h.api.deleteR2Objects.mockRejectedValueOnce(new Error('offline'));
		await expect(deleteCrateServer(h.input)).rejects.toThrow('uncertain outcome');
		const query = h.api.queryD1.getMockImplementation()!;
		h.api.queryD1.mockImplementation(async (account, database, sql, params) => {
			if (sql.startsWith('UPDATE maintenance_state SET value = ?')) {
				await query(account, database, sql, ['replacement-owner', params![1]!, params![2]!]);
			}
			return query(account, database, sql, params);
		});
		await expect(deleteCrateServer(h.input)).rejects.toThrow('Another deployment');
		expect(h.api.deleteR2Objects).toHaveBeenCalledOnce();
		expect(h.api.deleteR2Bucket).not.toHaveBeenCalled();
	});

	it('refuses recovery when the bucket was replaced', async () => {
		const h = harness();
		h.api.deleteR2Objects.mockRejectedValueOnce(new Error('offline'));
		await expect(deleteCrateServer(h.input)).rejects.toThrow();
		h.api.getR2Bucket.mockResolvedValue({ name: h.metadata.r2BucketName, creation_date: 'different' });
		await expect(deleteCrateServer(h.input)).rejects.toThrow('bucket identity changed');
		expect(h.api.deleteR2Bucket).not.toHaveBeenCalled();
	});
	it('removes the retired Worker after storage and keeps a deletion checkpoint', async () => {
		const h = harness();
		await deleteCrateServer(h.input);
		expect(h.api.deleteWorker).toHaveBeenCalledExactlyOnceWith(h.metadata.accountId, h.metadata.workerName);
		expect(h.api.deleteD1Database.mock.invocationCallOrder[0]).toBeLessThan(h.api.deleteWorker.mock.invocationCallOrder[0]!);
		expect(h.metadata.reset).toMatchObject({ deleteOnly: true, phase: 'rebuilding' });
	});

	it('resumes after the Worker DELETE response was lost without recreating anything', async () => {
		const h = harness();
		h.api.deleteWorker.mockRejectedValueOnce(new Error('Connection lost'));
		await expect(deleteCrateServer(h.input)).rejects.toThrow('Connection lost');
		h.api.listWorkers.mockResolvedValue([]);
		await deleteCrateServer(h.input);
		expect(h.api.deleteWorker).toHaveBeenCalledOnce();
		expect(h.api.retireCrateWorker).toHaveBeenCalledOnce();
		expect(h.api.deleteD1Database).toHaveBeenCalledOnce();
	});

	it('refuses a replacement Worker when retrying deletion', async () => {
		const h = harness();
		h.api.deleteWorker.mockRejectedValueOnce(new Error('Connection lost'));
		await expect(deleteCrateServer(h.input)).rejects.toThrow();
		h.worker.annotations = { 'workers/message': 'Crate 0.1.0' };
		await expect(deleteCrateServer(h.input)).rejects.toThrow('Worker changed');
		expect(h.api.deleteWorker).toHaveBeenCalledOnce();
	});

	it('refuses replacement storage when retrying deletion', async () => {
		const h = harness();
		await deleteCrateServer(h.input);
		h.api.getR2Bucket.mockResolvedValue({ name: h.metadata.r2BucketName, creation_date: 'new' });
		await expect(deleteCrateServer(h.input)).rejects.toThrow('recreated');
		expect(h.api.deleteWorker).toHaveBeenCalledOnce();
	});

	it('does not switch an interrupted reset into deletion', async () => {
		const h = harness();
		await resetCrateServer(h.input);
		await expect(deleteCrateServer(h.input)).rejects.toThrow('Finish the server reset');
		expect(h.api.deleteWorker).not.toHaveBeenCalled();
	});
});


it('identifies the exact unknown and missing tables before any deletion', async () => {
	const h = harness();
	h.api.queryD1.mockResolvedValue([{ results: [{ name: 'files' }, { name: 'unexpected_table' }] }]);
	await expect(resetCrateServer(h.input)).rejects.toThrow('Missing required Crate tables: auth_tokens. Unrecognized tables: "unexpected_table". No remote data was deleted.');
	expect(h.api.retireCrateWorker).not.toHaveBeenCalled();
	expect(h.api.deleteD1Database).not.toHaveBeenCalled();
	expect(h.api.deleteR2Bucket).not.toHaveBeenCalled();
	expect(h.input.beforeDelete).not.toHaveBeenCalled();
});


it.each([resetCrateServer, deleteCrateServer])('recognizes the baseline release tables during cleanup', async cleanup => {
	const h = harness();
	const query = h.api.queryD1.getMockImplementation()!;
	h.api.queryD1.mockImplementation(async (account, database, sql, params) => sql.includes('sqlite_master')
		? [{ results: ['files', 'auth_tokens', 'crate_release'].map(name => ({ name })) }]
		: query(account, database, sql, params));
	await cleanup(h.input);
	expect(h.api.deleteD1Database).toHaveBeenCalledOnce();
	expect(h.api.deleteR2Bucket).toHaveBeenCalledOnce();
});


it('reports real reset stages and successful object counts', async () => {
	const h = harness();
	const onProgress = vi.fn();
	await resetCrateServer({ ...h.input, onProgress });
	const messages = onProgress.mock.calls.map(call => call[0] as string);
	expect(messages).toContain('Checking remote files: 1 checked…');
	expect(messages).toContain('Removing remote files: 1 / 1 deleted…');
	expect(messages.indexOf('Checking remote files: 1 checked…')).toBeLessThan(messages.indexOf('Removing remote files: 1 / 1 deleted…'));
	expect(messages).toContain('Removing the old database…');
});

it('does not count a failed object deletion as completed', async () => {
	const h = harness();
	const onProgress = vi.fn();
	h.api.deleteR2Objects.mockRejectedValue(new Error('Request failed'));
	await expect(resetCrateServer({ ...h.input, onProgress })).rejects.toThrow('Request failed');
	expect(onProgress).toHaveBeenCalledWith('Removing remote files: 0 / 1 deleted…');
	expect(onProgress).not.toHaveBeenCalledWith('Removing remote files: 1 / 1 deleted…');
});

it.each([false, true])('re-lists only remaining objects after a partially applied bulk request (applied=%s)', async applied => {
	const h = harness();
	for (let i = 0; i < 2099; i++) h.objects.add(`__crate__/files/${i.toString(16).padStart(64, '0')}/01234567-89ab-cdef-0123-456789abcdef`);
	let requests = 0;
	h.api.deleteR2Objects.mockImplementation(async (_origin, _reset, _token, keys) => {
		if (++requests === 2) {
			if (applied) keys.slice(0, 90).forEach(key => h.objects.delete(key));
			throw new Error('connection lost');
		}
		keys.forEach(key => h.objects.delete(key));
	});
	await expect(deleteCrateServer(h.input)).rejects.toThrow('uncertain outcome');
	const remaining = [...h.objects];
	expect(remaining.length).toBe(applied ? 1010 : 1100);
	const previousToken = h.api.deleteR2Objects.mock.calls[0]![2];
	h.api.deleteR2Objects.mockClear();
	await deleteCrateServer(h.input);
	expect(h.api.deleteR2Objects.mock.calls.flatMap(([, , , keys]) => keys)).toEqual(remaining);
	expect(h.api.deleteR2Objects.mock.calls[0]![2]).not.toBe(previousToken);
	expect(h.objects.size).toBe(0);
});

it('shows an estimated time remaining once enough deletions have completed', async () => {
	const h = harness();
	for (let i = 0; i < 1999; i++) h.objects.add(`__crate__/files/${i.toString(16).padStart(64, '0')}/01234567-89ab-cdef-0123-456789abcdef`);
	const onProgress = vi.fn();
	let now = 0;
	const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
	try {
		h.api.deleteR2Objects.mockImplementation(async (_origin, _reset, _token, keys) => {
			now += 5000;
			keys.forEach(key => h.objects.delete(key));
		});
		await deleteCrateServer({ ...h.input, onProgress });
		expect(onProgress).toHaveBeenCalledWith('Removing remote files: 1,000 / 2,000 deleted · about 5 seconds remaining…');
		expect(onProgress).toHaveBeenCalledWith('Removing remote files: 2,000 / 2,000 deleted…');
	} finally {
		clock.mockRestore();
	}
});

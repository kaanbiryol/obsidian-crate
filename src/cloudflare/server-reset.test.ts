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
			? [{ name: 'storage_key' }] : ['files', 'auth_tokens', 'd1_migrations'].map(name => ({ name })) }]),
		listR2Objects: vi.fn(async (_account: string, _bucket: string, _cursor?: string): Promise<{ keys: string[]; cursor?: string }> => ({ keys: [...objects] })),
		deleteR2Object: vi.fn(async (_account: string, _bucket: string, key: string) => { objects.delete(key); }),
		deleteR2Bucket: vi.fn(async () => { bucket = null; }),
		deleteD1Database: vi.fn(async () => { database = null; }),
		retireCrateWorker: vi.fn(async (_account: string, _worker: string, resetId: string) => {
			worker.annotations = { 'workers/message': `Crate reset ${resetId}`, 'workers/tag': 'crate' };
			worker.bindings = worker.bindings!.filter(binding => binding.type !== 'durable_object_namespace');
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
		expect(api.deleteR2Object).toHaveBeenCalledExactlyOnceWith(metadata.accountId, metadata.r2BucketName, '__crate__/settings.json');
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
		expect(h.api.deleteR2Object).not.toHaveBeenCalled();
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
		expect(api.deleteR2Object).not.toHaveBeenCalled();
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
		expect(api.deleteR2Object).not.toHaveBeenCalled();
	});

	it('resumes a partially cleared bucket without repeating Durable Object deletion', async () => {
		const { input, api, metadata, objects, clearFence } = harness();
		const key = `__crate__/files/${'a'.repeat(64)}/01234567-89ab-cdef-0123-456789abcdef`;
		objects.add(key);
		api.deleteR2Object.mockImplementationOnce(async (_account, _bucket, item) => { objects.delete(item); })
			.mockRejectedValueOnce(new Error('temporary network error'));
		await expect(resetCrateServer(input)).rejects.toThrow('temporary network error');
		expect(metadata.reset?.phase).toBe('clearing');
		expect(api.deleteD1Database).not.toHaveBeenCalled();
		clearFence(); // Explicit recovery after the abandoned request has settled.
		await resetCrateServer(input);
		expect(objects.size).toBe(0);
		expect(api.retireCrateWorker).toHaveBeenCalledOnce();
		expect(metadata.reset?.phase).toBe('rebuilding');
		const deletionCount = api.deleteR2Object.mock.calls.length;
		await resetCrateServer(input);
		expect(api.deleteR2Object).toHaveBeenCalledTimes(deletionCount);
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
		api.deleteR2Object.mockRejectedValueOnce(new Error('offline'));
		await expect(resetCrateServer(input)).rejects.toThrow('offline');
		api.getR2Bucket.mockResolvedValue({ name: metadata.r2BucketName, creation_date: 'different-creation-date' });
		await expect(resetCrateServer(input)).rejects.toThrow('bucket identity changed');
		expect(api.deleteR2Object).toHaveBeenCalledOnce();
		expect(api.deleteD1Database).not.toHaveBeenCalled();
	});

	it('persists the reset identity before retiring the Worker', async () => {
		const { input, api } = harness();
		input.persist.mockRejectedValue(new Error('disk full'));
		await expect(resetCrateServer(input)).rejects.toThrow('disk full');
		expect(api.retireCrateWorker).not.toHaveBeenCalled();
		expect(api.deleteR2Object).not.toHaveBeenCalled();
	});

});


describe('delete-only server removal', () => {
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


it.each([resetCrateServer, deleteCrateServer])('recognizes the original OAuth provisioner migration table during cleanup', async cleanup => {
	const h = harness();
	const query = h.api.queryD1.getMockImplementation()!;
	h.api.queryD1.mockImplementation(async (account, database, sql, params) => sql.includes('sqlite_master')
		? [{ results: ['files', 'auth_tokens', '_crate_migrations'].map(name => ({ name })) }]
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
	expect(messages).toContain('Removing remote files: 1 deleted…');
	expect(messages.indexOf('Checking remote files: 1 checked…')).toBeLessThan(messages.indexOf('Removing remote files: 1 deleted…'));
	expect(messages).toContain('Removing the old database…');
});

it('does not count a failed object deletion as completed', async () => {
	const h = harness();
	const onProgress = vi.fn();
	h.api.deleteR2Object.mockRejectedValue(new Error('Request failed'));
	await expect(resetCrateServer({ ...h.input, onProgress })).rejects.toThrow('Request failed');
	expect(onProgress).toHaveBeenCalledWith('Removing remote files: 0 deleted…');
	expect(onProgress).not.toHaveBeenCalledWith('Removing remote files: 1 deleted…');
});

/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { provisionCloudflareDeployment } from '../provisioner';
import { resetCrateServer } from '../server-reset';
import { CloudflareApiError, type CloudflareWorkerSettings } from '../cloudflare-api';
import { DEPLOYMENT_FENCE_KEY } from '../deployment-fence';
import type { CloudflareDeploymentMetadata } from '../deployment-types';

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}
const artifact = (version = '0.1.0', fingerprint = 'f'.repeat(64)) => ({ version, fingerprint, workerBundle: 'worker', workerBundleSha256: 'hash', d1Schema: schema, d1SchemaSha256: 'hash' });

async function harness(empty = false) {
	const metadata: CloudflareDeploymentMetadata = {
		deploymentId: '0123456789abcdef', accountId: 'a'.repeat(32), accountName: 'Test', workerName: 'crate-0123456789abcdef',
		d1DatabaseName: 'crate-0123456789abcdef', d1DatabaseId: '01234567-89ab-cdef-0123-456789abcdef', r2BucketName: 'crate-0123456789abcdef',
		workersSubdomain: 'test', lastDeployedVersion: null, lastDeployedFingerprint: null,
	};
	if (!empty) for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
	const bindings = [{ type: 'd1', name: 'DB', id: metadata.d1DatabaseId! }, { type: 'r2_bucket', name: 'BUCKET', bucket_name: metadata.r2BucketName },
		{ type: 'durable_object_namespace', name: 'REMINDER_ALARMS', class_name: 'ReminderAlarm', namespace_id: 'c'.repeat(32) }];
	const state: { worker: CloudflareWorkerSettings | null; database: boolean; bucket: boolean } = {
		worker: empty ? null : { annotations: { 'workers/message': `Crate 0.1.0 ${'0'.repeat(64)}` }, bindings }, database: !empty, bucket: !empty,
	};
	const database = { uuid: metadata.d1DatabaseId!, name: metadata.d1DatabaseName };
	const api = {
		getWorkerSettings: vi.fn(async () => { if (!state.worker) throw new CloudflareApiError('absent', 404, null); return structuredClone(state.worker); }),
		getD1Database: vi.fn(async () => state.database ? database : null),
		findD1Database: vi.fn(async () => state.database ? database : null),
		createD1Database: vi.fn(async () => { if (state.database) throw new CloudflareApiError('exists', 400, 7502); state.database = true; return database; }),
		getR2Bucket: vi.fn(async () => state.bucket ? { name: metadata.r2BucketName, creation_date: '2026-01-01' } : null),
		createR2Bucket: vi.fn(async () => { state.bucket = true; }),
		queryD1: vi.fn(async (_account: string, _db: string, sql: string, params?: string[]) => {
			if (!state.database) throw new CloudflareApiError('absent', 404, null);
			const results = [];
			for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) results.push(await env.DB.prepare(statement).bind(...params ?? []).all());
			return results;
		}),
		uploadWorker: vi.fn(async (input: { artifacts: ReturnType<typeof artifact> }) => { state.worker = { annotations: { 'workers/message': `Crate ${input.artifacts.version} ${input.artifacts.fingerprint}` }, bindings }; }),
		updateWorkerSchedules: vi.fn(async () => {}), getWorkersSubdomain: vi.fn(async (): Promise<string | null> => 'test'),
		createWorkersSubdomain: vi.fn(async () => 'test'), enableWorkerSubdomain: vi.fn(async () => {}),
		listWorkers: vi.fn(async () => [{ id: metadata.workerName }]),
		listDurableObjectNamespaces: vi.fn(async () => state.worker?.bindings?.some(binding => binding.type === 'durable_object_namespace') ? [{ id: 'c'.repeat(32), script: metadata.workerName, class: 'ReminderAlarm' }] : []),
		listR2Objects: vi.fn(async () => ({ keys: [] })), deleteR2Object: vi.fn(async () => {}),
		deleteR2Bucket: vi.fn(async () => { state.bucket = false; }), deleteD1Database: vi.fn(async () => { state.database = false; }),
		retireCrateWorker: vi.fn(async (_account: string, _name: string, resetId: string) => { state.worker = { annotations: { 'workers/message': `Crate reset ${resetId}` }, bindings: bindings.slice(0, 2) }; }),
	};
	const deploy = (build = artifact(), client = api, saved = structuredClone(metadata)) => provisionCloudflareDeployment({ api: client as never,
		accountId: metadata.accountId!, metadata: saved, artifacts: build, onMetadataChanged: async () => {} });
	const resetInput = { api, accountId: metadata.accountId!, metadata: structuredClone(metadata), version: '0.1.0', beforeDelete: vi.fn(async () => {}), persist: vi.fn(async () => {}) };
	return { api, state, metadata, deploy, resetInput };
}
async function held() { return env.DB.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(DEPLOYMENT_FENCE_KEY).first<{ value: string }>(); }

it('serializes same-version updates with different fingerprints through the entire publication', async () => {
	const h = await harness();
	const gate = deferred(); const started = deferred();
	const upload = h.api.uploadWorker.getMockImplementation()!;
	h.api.uploadWorker.mockImplementationOnce(async input => { started.resolve(); await gate.promise; await upload(input); });
	const first = h.deploy(); await started.promise;
	await expect(h.deploy(artifact('0.1.0', 'e'.repeat(64)))).rejects.toThrow('Another deployment');
	expect(h.api.uploadWorker).toHaveBeenCalledOnce();
	gate.resolve(); await first;
	expect(await held()).toBeNull();
	await h.deploy(artifact('0.1.0', 'e'.repeat(64)));
	expect(h.state.worker?.annotations?.['workers/message']).toContain('e'.repeat(64));
});

it.each(['0.1.0', '0.2.0'])('rejects a stale preflight when another device publishes %s before acquisition', async version => {
	const h = await harness();
	const gate = deferred(); const started = deferred();
	const olderApi = { ...h.api, getD1Database: vi.fn(async () => { started.resolve(); await gate.promise; return h.api.getD1Database(); }) };
	const older = h.deploy(artifact(), olderApi);
	const rejection = expect(older).rejects.toThrow(version === '0.1.0' ? 'server changed' : 'downgrades are not supported');
	await started.promise;
	await h.deploy(artifact(version, 'e'.repeat(64)));
	gate.resolve(); await rejection;
	expect(h.api.uploadWorker).toHaveBeenCalledOnce();
	expect(await held()).toBeNull();
});

it('keeps an uncertain upload fenced even after an arbitrarily late provider commit', async () => {
	const h = await harness();
	const upload = h.api.uploadWorker.getMockImplementation()!;
	h.api.uploadWorker.mockRejectedValueOnce(new Error('transport timed out'));
	await expect(h.deploy()).rejects.toThrow('fence remains held');
	const owner = await held();
	await expect(h.deploy(artifact('0.2.0'))).rejects.toThrow('Another deployment');
	await upload({ artifacts: artifact() }); // The timed-out request completes remotely later.
	await expect(h.deploy(artifact('0.2.0'))).rejects.toThrow('Another deployment');
	expect(await held()).toEqual(owner);
	// Only explicit recovery after quiescence permits a new updater.
	await env.DB.prepare('DELETE FROM maintenance_state WHERE key = ? AND value = ?').bind(DEPLOYMENT_FENCE_KEY, owner!.value).run();
	await h.deploy(artifact('0.2.0'));
});

it('releases a definite publication rejection but does not retry an uncertain subdomain creation', async () => {
	const h = await harness();
	h.api.uploadWorker.mockRejectedValueOnce(new CloudflareApiError('forbidden', 403, null));
	await expect(h.deploy()).rejects.toThrow('forbidden');
	expect(await held()).toBeNull();
	h.api.getWorkersSubdomain.mockResolvedValue(null);
	h.api.createWorkersSubdomain.mockRejectedValueOnce(new Error('lost subdomain response'));
	await expect(h.deploy()).rejects.toThrow('fence remains held');
	expect(h.api.createWorkersSubdomain).toHaveBeenCalledOnce();
	expect(await held()).not.toBeNull();
});

it('prevents reset from starting while an update owns publication', async () => {
	const h = await harness();
	const gate = deferred(); const started = deferred();
	const upload = h.api.uploadWorker.getMockImplementation()!;
	h.api.uploadWorker.mockImplementationOnce(async input => { started.resolve(); await gate.promise; await upload(input); });
	const update = h.deploy(); await started.promise;
	await expect(resetCrateServer(h.resetInput)).rejects.toThrow('Another deployment');
	expect(h.resetInput.beforeDelete).not.toHaveBeenCalled();
	expect(h.api.retireCrateWorker).not.toHaveBeenCalled();
	gate.resolve(); await update;
	await resetCrateServer(h.resetInput);
	expect(h.state.database).toBe(false);
});

it('rechecks the version before retirement when another updater wins reset preflight', async () => {
	const h = await harness();
	const gate = deferred(); const started = deferred();
	const database = h.api.getD1Database.getMockImplementation()!;
	h.api.getD1Database.mockImplementationOnce(async () => { started.resolve(); await gate.promise; return database(); });
	const resetting = resetCrateServer(h.resetInput);
	const rejection = expect(resetting).rejects.toThrow('downgrades are not supported');
	await started.promise;
	await h.deploy(artifact('0.2.0'));
	gate.resolve(); await rejection;
	expect(h.api.retireCrateWorker).not.toHaveBeenCalled();
	expect(h.state.database).toBe(true);
	expect(await held()).toBeNull();
});

it('prevents update from publishing while reset is in flight and after its database is removed', async () => {
	const h = await harness();
	const gate = deferred(); const started = deferred();
	const retire = h.api.retireCrateWorker.getMockImplementation()!;
	h.api.retireCrateWorker.mockImplementationOnce(async (...args) => { started.resolve(); await gate.promise; await retire(...args); });
	const resetting = resetCrateServer(h.resetInput); await started.promise;
	await expect(h.deploy()).rejects.toThrow('Another deployment');
	gate.resolve(); await resetting;
	await expect(h.deploy()).rejects.toThrow('being reset or deleted');
	expect(h.api.uploadWorker).not.toHaveBeenCalled();
});

it('preserves reset ownership/checkpoint while an uncertain retirement awaits explicit recovery', async () => {
	const h = await harness();
	const retire = h.api.retireCrateWorker.getMockImplementation()!;
	h.api.retireCrateWorker.mockImplementationOnce(async (...args) => { await retire(...args); throw new Error('lost retirement response'); });
	await expect(resetCrateServer(h.resetInput)).rejects.toThrow('fence remains held');
	expect(h.resetInput.metadata.reset?.phase).toBe('clearing');
	await expect(resetCrateServer(h.resetInput)).rejects.toThrow('Another deployment');
	const owner = await held();
	await env.DB.prepare('DELETE FROM maintenance_state WHERE key = ? AND value = ?').bind(DEPLOYMENT_FENCE_KEY, owner!.value).run();
	await resetCrateServer(h.resetInput);
	expect(h.api.retireCrateWorker).toHaveBeenCalledOnce();
	expect(h.resetInput.metadata.reset?.phase).toBe('rebuilding');
});

it('bootstraps one named database and prevents a second initial provisioner from publishing', async () => {
	const h = await harness(true);
	const gate = deferred(); const started = deferred();
	const upload = h.api.uploadWorker.getMockImplementation()!;
	h.api.uploadWorker.mockImplementationOnce(async input => { started.resolve(); await gate.promise; await upload(input); });
	const first = h.deploy(); await started.promise;
	await expect(h.deploy()).rejects.toThrow('Another deployment');
	expect(h.api.createD1Database).toHaveBeenCalledOnce();
	gate.resolve(); await first;
	expect(h.api.uploadWorker).toHaveBeenCalledOnce();
});

it('uses the provider name-conflict result without assuming immediate database discovery', async () => {
	const h = await harness(true);
	const create = h.api.createD1Database.getMockImplementation()!;
	h.api.createD1Database.mockImplementationOnce(async () => {
		await create();
		throw new CloudflareApiError('exists', 400, 7502);
	});
	h.api.findD1Database.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
	await expect(h.deploy()).rejects.toThrow('exists');
	expect(h.api.uploadWorker).not.toHaveBeenCalled();
	await h.deploy();
	expect(h.api.createD1Database).toHaveBeenCalledOnce();
	expect(h.api.uploadWorker).toHaveBeenCalledOnce();
});

it('does not turn an unknown initial database creation into permission to publish', async () => {
	const h = await harness(true);
	const create = h.api.createD1Database.getMockImplementation()!;
	h.api.createD1Database.mockImplementationOnce(async () => { await create(); throw new Error('lost create response'); });
	await expect(h.deploy()).rejects.toThrow('lost create response');
	expect(h.api.uploadWorker).not.toHaveBeenCalled();
	expect(h.api.findD1Database).toHaveBeenCalledOnce();
});

it('refuses stale resource metadata instead of acquiring a fence in a different database', async () => {
	const h = await harness();
	const wrong = { ...h.metadata, d1DatabaseId: 'other-database' };
	await expect(h.deploy(artifact(), h.api, wrong)).rejects.toThrow('bindings do not match');
	expect(await held()).toBeNull();
	expect(h.api.uploadWorker).not.toHaveBeenCalled();
});

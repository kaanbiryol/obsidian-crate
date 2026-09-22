import { recoverDeployment } from '../deployment-recovery';
import { completePublishedDeployment } from '../complete-published-deployment';
/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { provisionCloudflareDeployment } from '../provisioner';
import { resetCrateServer } from '../server-reset';
import { CloudflareApiError, type CloudflareWorkerSettings } from '../cloudflare-api';
import { DEPLOYMENT_FENCE_KEY } from '../deployment-fence';
import { SERVER_RELEASE } from '../database-upgrades';
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
		verifyWorkerDeployment: vi.fn(async () => {}), verifyResetWorker: vi.fn(async () => {}),
		verifyPublishedWorkerDeployment: vi.fn(async () => ({ revision: SERVER_RELEASE.revision - 1, schemaVersion: SERVER_RELEASE.schemaVersion })),
		uploadWorker: vi.fn(async (input: { artifacts: ReturnType<typeof artifact> }) => { state.worker = { annotations: { 'workers/message': `Crate ${input.artifacts.version} ${input.artifacts.fingerprint}` }, bindings }; }),
		updateWorkerSchedules: vi.fn(async () => {}), getWorkersSubdomain: vi.fn(async (): Promise<string | null> => 'test'),
		createWorkersSubdomain: vi.fn(async () => 'test'), enableWorkerSubdomain: vi.fn(async () => {}),
		getWorkerSubdomain: vi.fn(async () => ({ enabled: true, previews_enabled: false })),
		listWorkers: vi.fn(async () => [{ id: metadata.workerName }]),
		listDurableObjectNamespaces: vi.fn(async () => state.worker?.bindings?.some(binding => binding.type === 'durable_object_namespace') ? [{ id: 'c'.repeat(32), script: metadata.workerName, class: 'ReminderAlarm' }] : []),
		listR2Objects: vi.fn(async () => ({ keys: [] })), deleteR2Objects: vi.fn(async () => {}),
		deleteR2Bucket: vi.fn(async () => { state.bucket = false; }), deleteD1Database: vi.fn(async () => { state.database = false; }),
		retireCrateWorker: vi.fn(async (_account: string, _name: string, resetId: string) => { state.worker = { annotations: { 'workers/message': `Crate reset ${resetId}` }, bindings: [...bindings.slice(0, 2), { type: 'plain_text', name: 'CRATE_RESET_ID', text: resetId }] }; }),
	};
	const deploy = (build = artifact(), client = api, saved = { ...structuredClone(metadata), d1DatabaseId: empty ? null : metadata.d1DatabaseId }) => provisionCloudflareDeployment({ api: client as never,
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
	await expect(h.deploy(artifact('0.1.0', 'e'.repeat(64)))).rejects.toThrow('different build');
	expect(h.state.worker?.annotations?.['workers/message']).toContain('f'.repeat(64));
});

it.each(['0.1.0', '0.2.0'])('rejects a stale preflight when another device publishes %s before acquisition', async version => {
	const h = await harness();
	const gate = deferred(); const started = deferred();
	const olderApi = { ...h.api, getD1Database: vi.fn(async () => { started.resolve(); await gate.promise; return h.api.getD1Database(); }) };
	const older = h.deploy(artifact(), olderApi);
	const rejection = expect(older).rejects.toThrow(version === '0.1.0' ? 'different build' : 'downgrades are not supported');
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
	expect(JSON.parse(owner!.value)).toMatchObject({ step: 'upload-worker', stepState: 'started' });
	await expect(h.deploy(artifact('0.2.0'))).rejects.toThrow('Another deployment');
	await upload({ artifacts: artifact() }); // The timed-out request completes remotely later.
	await expect(h.deploy(artifact('0.2.0'))).rejects.toThrow('Another deployment');
	expect(await held()).toEqual(owner);
	// Only explicit recovery after quiescence permits a new updater.
	await env.DB.prepare('DELETE FROM maintenance_state WHERE key = ? AND value = ?').bind(DEPLOYMENT_FENCE_KEY, owner!.value).run();
	await h.deploy(artifact('0.2.0'));
});

it('preserves definite publication rejections for recovery and does not retry uncertain subdomain creation', async () => {
	const h = await harness();
	h.api.uploadWorker.mockRejectedValueOnce(new CloudflareApiError('forbidden', 403, null));
	await expect(h.deploy()).rejects.toThrow('forbidden');
	expect(JSON.parse((await held())!.value)).toMatchObject({ stepState: 'rejected' });
  await reset();
  const next = await harness();
	next.api.getWorkersSubdomain.mockResolvedValue(null);
	next.api.createWorkersSubdomain.mockRejectedValueOnce(new Error('lost subdomain response'));
	await expect(next.deploy()).rejects.toThrow('fence remains held');
	expect(next.api.createWorkersSubdomain).toHaveBeenCalledOnce();
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

it('recovery of a confirmed step prevents the old updater from sending its next mutation', async () => {
    const h = await harness();
    const gate = deferred();
    const started = deferred();
    h.api.getWorkersSubdomain.mockImplementationOnce(async () => {
        started.resolve();
        await gate.promise;
        return 'test';
    });
    const updating = h.deploy();
    const rejected = expect(updating).rejects.toThrow('Deployment ownership changed');
    await started.promise;
    expect(JSON.parse((await held())!.value)).toMatchObject({ recoveryProtocol: 1, step: 'prepare-database', stepState: 'confirmed' });
    expect((await recoverDeployment(h.api, h.metadata)).status).toBe('recovered');
    gate.resolve();
    await rejected;
    expect(h.api.uploadWorker).not.toHaveBeenCalled();
});


it('preserves existing file references and never reapplies fresh DDL during an update', async () => {
  const h = await harness();
  await env.DB.prepare("INSERT INTO files(path, portable_path, storage_key) VALUES ('Notes/École.md', 'notes/école.md', 'existing-key')").run();
  await h.deploy();
  expect(await held()).toBeNull();
  expect(await env.DB.prepare('SELECT version FROM crate_schema').first()).toEqual({ version: 2 });
  expect(await env.DB.prepare('SELECT path, storage_key FROM files').first()).toEqual({ path: 'Notes/École.md', storage_key: 'existing-key' });
  expect(h.api.queryD1.mock.calls.some(call => call[2] === schema)).toBe(false);
  expect(h.api.verifyWorkerDeployment).toHaveBeenCalledOnce();
});

it('keeps a failed live check locked until the published build is verified', async () => {
  const h = await harness();
  h.api.verifyWorkerDeployment.mockRejectedValueOnce(new Error('not live yet'));
  await expect(h.deploy()).rejects.toThrow('matching Worker and database verified');
  const record = JSON.parse((await held())!.value) as Record<string, unknown>;
  expect(record).toMatchObject({ verificationPending: true, step: 'enable-server-address', stepState: 'confirmed' });
  expect((await recoverDeployment(h.api as never, h.metadata, 'a'.repeat(64))).status).toBe('verify');
  const recovery = await recoverDeployment(h.api as never, h.metadata, artifact().fingerprint);
  expect(recovery.status).toBe('verify');
  expect(await held()).not.toBeNull();
  await completePublishedDeployment(h.api, h.metadata, artifact(), recovery.resumeValue!);
  expect(await held()).toBeNull();
});

it('blocks lower revisions and different artifacts at the same revision before publication', async () => {
  const h = await harness();
  await h.deploy();
  await expect(h.deploy(artifact('0.1.0', 'a'.repeat(64)))).rejects.toThrow('different build');
  await env.DB.prepare('UPDATE crate_release SET revision = ?').bind(SERVER_RELEASE.revision + 1).run();
  await expect(h.deploy()).rejects.toThrow('newer or different build');
  expect(h.api.uploadWorker).toHaveBeenCalledTimes(1);
});

it('keeps initialization recoverable after a definite upload rejection', async () => {
  const h = await harness(true);
  h.api.uploadWorker.mockRejectedValueOnce(new CloudflareApiError('rejected', 403, null));
  await expect(h.deploy()).rejects.toThrow('matching Worker and database verified');
  expect(JSON.parse((await held())!.value)).toMatchObject({ verificationPending: true, step: 'upload-worker', stepState: 'rejected' });
  const recovery = await recoverDeployment(h.api, h.metadata, artifact().fingerprint);
  expect(recovery.status).toBe('resume');
  await provisionCloudflareDeployment({ api: h.api as never, accountId: h.metadata.accountId!, metadata: h.metadata,
    artifacts: artifact(), resumeUpdateValue: recovery.resumeValue, onMetadataChanged: async () => {} });
  expect(await held()).toBeNull();
  expect(h.api.queryD1.mock.calls.filter(call => call[2] === schema)).toHaveLength(1);
});

it.each([false, true])('recovers a lost acquisition response before any provider mutation (empty: %s)', async empty => {
  const h = await harness(empty);
  const query = h.api.queryD1.getMockImplementation()!;
  let lost = false;
  h.api.queryD1.mockImplementation(async (...args) => {
    const result = await query(...args);
    if (!lost && args[2].startsWith('INSERT INTO maintenance_state')) {
      lost = true;
      throw new Error('lost acquisition response');
    }
    return result;
  });
  await expect(h.deploy()).rejects.toThrow('Could not confirm deployment ownership');
  expect(JSON.parse((await held())!.value)).toMatchObject({ step: 'acquire-deployment', stepState: 'confirmed', verificationPending: false });
  expect(h.api.uploadWorker).not.toHaveBeenCalled();
  expect(h.api.createR2Bucket).not.toHaveBeenCalled();
  expect((await recoverDeployment(h.api, h.metadata, artifact().fingerprint)).status).toBe('recovered');
  await h.deploy();
  expect(await held()).toBeNull();
});

it('keeps repeated lost takeover responses recoverable without ever unlocking pending writes', async () => {
  const h = await harness();
  h.api.verifyWorkerDeployment.mockRejectedValueOnce(new Error('not live yet'));
  await expect(h.deploy()).rejects.toThrow('matching Worker and database verified');
  const query = h.api.queryD1.getMockImplementation()!;
  const resume = (resumeUpdateValue: string | undefined) => completePublishedDeployment(h.api, h.metadata, artifact(), resumeUpdateValue!);
  for (let attempt = 0; attempt < 2; attempt++) {
    const recovery = await recoverDeployment(h.api, h.metadata, artifact().fingerprint);
    expect(recovery.status).toBe('verify');
    const previous = JSON.parse(recovery.resumeValue!) as { owner: string };
    let lost = false;
    h.api.queryD1.mockImplementation(async (...args) => {
      const result = await query(...args);
      if (!lost && args[2].startsWith('UPDATE maintenance_state')) {
        lost = true;
        expect(await held()).not.toBeNull();
        throw new Error('lost takeover response');
      }
      return result;
    });
    await expect(resume(recovery.resumeValue)).rejects.toThrow('Could not confirm deployment ownership');
    const next = JSON.parse((await held())!.value) as { owner: string };
    expect(next).toMatchObject({ step: 'acquire-deployment', stepState: 'confirmed', verificationPending: true });
    expect(next.owner).not.toBe(previous.owner);
    // A client holding the old snapshot cannot take ownership back.
    await expect(resume(recovery.resumeValue)).rejects.toThrow('Another deployment');
  }
  h.api.queryD1.mockImplementation(query);
  expect(h.api.uploadWorker).toHaveBeenCalledTimes(1);
  expect(h.api.queryD1.mock.calls.some(([, , sql]) => sql.startsWith('DELETE FROM maintenance_state'))).toBe(false);
  const recovery = await recoverDeployment(h.api, h.metadata, artifact().fingerprint);
  await resume(recovery.resumeValue);
  expect(await held()).toBeNull();
  expect(h.api.uploadWorker).toHaveBeenCalledTimes(1);
});

it('prevents a paused owner from advancing after its acquisition checkpoint is recovered', async () => {
  const h = await harness();
  const gate = deferred(), acquired = deferred();
  const query = h.api.queryD1.getMockImplementation()!;
  h.api.queryD1.mockImplementation(async (...args) => {
    const result = await query(...args);
    if (args[2].startsWith('INSERT INTO maintenance_state')) {
      acquired.resolve();
      await gate.promise;
    }
    return result;
  });
  const updating = h.deploy();
  const rejected = expect(updating).rejects.toThrow('Could not checkpoint');
  await acquired.promise;
  expect((await recoverDeployment(h.api, h.metadata)).status).toBe('recovered');
  gate.resolve();
  await rejected;
  expect(h.api.uploadWorker).not.toHaveBeenCalled();
  expect(await held()).toBeNull();
});

it('refuses a schema edit hidden inside a code-only release and preserves storage', async () => {
  const h = await harness();
  await h.deploy();
  const changed = { ...artifact(), d1SchemaSha256: 'changed-schema' };
  await expect(h.deploy(changed)).rejects.toThrow('schema version change');
  expect(h.api.uploadWorker).toHaveBeenCalledTimes(1);
  expect(await held()).toBeNull();
});

it('refuses missing saved storage rather than silently creating a replacement database', async () => {
  const h = await harness();
  h.state.database = false;
  await expect(h.deploy()).rejects.toThrow('saved server database is missing');
  expect(h.api.createD1Database).not.toHaveBeenCalled();
  expect(h.api.uploadWorker).not.toHaveBeenCalled();
});

it('refuses a missing file bucket instead of substituting empty storage', async () => {
  const h = await harness();
  h.state.bucket = false;
  await expect(h.deploy()).rejects.toThrow('file bucket is missing');
  expect(h.api.createR2Bucket).not.toHaveBeenCalled();
  expect(h.api.uploadWorker).not.toHaveBeenCalled();
});

it('finishes a confirmed older publication from a newer plugin without uploading or changing vault data', async () => {
  const h = await harness();
  await env.DB.prepare("INSERT INTO files(path, portable_path, storage_key) VALUES ('Notes/Keep.md', 'notes/keep.md', 'existing-key')").run();
  h.api.verifyWorkerDeployment.mockRejectedValueOnce(new Error('Old public route'));
  await expect(h.deploy()).rejects.toThrow('fence remains held');
  const value = (await held())!.value;
  const newer = artifact('0.2.0', 'e'.repeat(64));
  expect((await recoverDeployment(h.api, h.metadata, newer.fingerprint)).status).toBe('verify');
  const filesBefore = await env.DB.prepare('SELECT * FROM files').all();
  await completePublishedDeployment(h.api, h.metadata, newer, value);
  expect(await held()).toBeNull();
  expect(await env.DB.prepare('SELECT revision, fingerprint FROM crate_release WHERE id = 1').first()).toEqual({ revision: SERVER_RELEASE.revision - 1, fingerprint: artifact().fingerprint });
  expect(h.metadata.lastDeployedFingerprint).toBe(artifact().fingerprint);
  expect(h.api.uploadWorker).toHaveBeenCalledTimes(1);
  expect(h.api.enableWorkerSubdomain).not.toHaveBeenCalled();
  expect((await env.DB.prepare('SELECT * FROM files').all()).results).toEqual(filesBefore.results);
});

it('keeps failed publication verification locked and permits checking it again', async () => {
  const h = await harness();
  h.api.verifyWorkerDeployment.mockRejectedValueOnce(new Error('Old public route'));
  await expect(h.deploy()).rejects.toThrow('fence remains held');
  const newer = artifact('0.2.0', 'e'.repeat(64));
  h.api.verifyPublishedWorkerDeployment.mockRejectedValueOnce(new Error('Public fingerprint mismatch'));
  await expect(completePublishedDeployment(h.api, h.metadata, newer, (await held())!.value)).rejects.toThrow('Public fingerprint mismatch');
  expect(JSON.parse((await held())!.value)).toMatchObject({ completionOnly: true, verificationPending: true, step: 'acquire-deployment', stepState: 'confirmed' });
  const recovery = await recoverDeployment(h.api, h.metadata, newer.fingerprint);
  expect(recovery.status).toBe('verify');
  await completePublishedDeployment(h.api, h.metadata, newer, recovery.resumeValue!);
  expect(await held()).toBeNull();
  expect(h.api.uploadWorker).toHaveBeenCalledTimes(1);
});

it('does not take ownership if the old updater advances after inspection', async () => {
  const h = await harness();
  h.api.verifyWorkerDeployment.mockRejectedValueOnce(new Error('Old public route'));
  await expect(h.deploy()).rejects.toThrow('fence remains held');
  const value = (await held())!.value;
  const advanced = JSON.stringify({ ...JSON.parse(value), step: 'record-release', stepState: 'started' });
  await env.DB.prepare('UPDATE maintenance_state SET value = ? WHERE key = ?').bind(advanced, DEPLOYMENT_FENCE_KEY).run();
  await expect(completePublishedDeployment(h.api, h.metadata, artifact('0.2.0', 'e'.repeat(64)), value)).rejects.toThrow('Another deployment');
  expect((await held())!.value).toBe(advanced);
  expect(h.api.verifyPublishedWorkerDeployment).not.toHaveBeenCalled();
});

it.each(['storage', 'schema', 'release'])('retains the publication lock when %s verification fails', async problem => {
  const h = await harness();
  h.api.verifyWorkerDeployment.mockRejectedValueOnce(new Error('Old public route'));
  await expect(h.deploy()).rejects.toThrow('fence remains held');
  if (problem === 'storage') h.state.worker!.bindings![0]!.id = 'different-database';
  if (problem === 'schema') await env.DB.prepare('UPDATE crate_schema SET version = 999').run();
  if (problem === 'release') h.api.verifyPublishedWorkerDeployment.mockResolvedValue({ revision: SERVER_RELEASE.revision + 1, schemaVersion: SERVER_RELEASE.schemaVersion });
  await expect(completePublishedDeployment(h.api, h.metadata, artifact('0.2.0', 'e'.repeat(64)), (await held())!.value)).rejects.toThrow('fence remains held');
  expect(await held()).not.toBeNull();
  expect(await env.DB.prepare('SELECT * FROM crate_release').first()).toBeNull();
});

it('never retries an unconfirmed release-record write during publication recovery', async () => {
  const h = await harness();
  h.api.verifyWorkerDeployment.mockRejectedValueOnce(new Error('Old public route'));
  await expect(h.deploy()).rejects.toThrow('fence remains held');
  const query = h.api.queryD1.getMockImplementation()!;
  h.api.queryD1.mockImplementation(async (...args) => {
    const result = await query(...args);
    if (args[2].startsWith('INSERT INTO crate_release')) throw new Error('Lost release write response');
    return result;
  });
  const newer = artifact('0.2.0', 'e'.repeat(64));
  await expect(completePublishedDeployment(h.api, h.metadata, newer, (await held())!.value)).rejects.toThrow('Lost release write response');
  expect(JSON.parse((await held())!.value)).toMatchObject({ completionOnly: true, step: 'record-release', stepState: 'started' });
  expect((await recoverDeployment(h.api, h.metadata, newer.fingerprint)).status).toBe('blocked');
  expect(h.api.queryD1.mock.calls.some(([, , sql]) => sql.startsWith('DELETE FROM maintenance_state'))).toBe(false);
});

it('recovers an observed address activation and prevents its late owner from advancing', async () => {
  const h = await harness();
  const dispatched = deferred();
  const response = deferred();
  h.api.getWorkerSubdomain.mockResolvedValueOnce({ enabled: false, previews_enabled: false });
  h.api.enableWorkerSubdomain.mockImplementationOnce(async () => { dispatched.resolve(); await response.promise; });
  const oldUpdate = h.deploy();
  const oldFailure = expect(oldUpdate).rejects.toThrow('checkpoint');
  await dispatched.promise;
  expect(JSON.parse((await held())!.value)).toMatchObject({ step: 'enable-server-address', stepState: 'started' });
  const recovery = await recoverDeployment(h.api, h.metadata, artifact().fingerprint);
  expect(recovery.status).toBe('verify');
  await completePublishedDeployment(h.api, h.metadata, artifact(), recovery.resumeValue!);
  expect(await held()).toBeNull();
  expect(h.api.enableWorkerSubdomain).toHaveBeenCalledTimes(1);
  // A delayed identical route-setting request cannot republish the old Worker.
  const newer = artifact('0.2.0', 'e'.repeat(64));
  await h.deploy(newer);
  response.resolve();
  await oldFailure;
  expect(await held()).toBeNull();
  expect(await env.DB.prepare('SELECT fingerprint FROM crate_release WHERE id = 1').first()).toEqual({ fingerprint: newer.fingerprint });
  expect(h.state.worker!.annotations!['workers/message']).toContain(newer.fingerprint);
  expect(h.api.enableWorkerSubdomain).toHaveBeenCalledTimes(1);
});

it.each([{ enabled: false, previews_enabled: false }, { enabled: true, previews_enabled: true }])('keeps an unconfirmed activation untouched when address settings differ: %j', async address => {
  const h = await harness();
  h.api.getWorkerSubdomain.mockResolvedValue(address);
  h.api.enableWorkerSubdomain.mockRejectedValueOnce(new Error('Lost activation response'));
  await expect(h.deploy()).rejects.toThrow('Lost activation response');
  const original = (await held())!.value;
  await expect(completePublishedDeployment(h.api, h.metadata, artifact(), original)).rejects.toThrow('address settings');
  expect((await held())!.value).toBe(original);
  expect(h.api.verifyPublishedWorkerDeployment).not.toHaveBeenCalled();
});

 it('replaces a rejected upload with a corrected artifact while preserving the fence and vault data', async () => {
  const h = await harness();
  await env.DB.prepare("INSERT INTO maintenance_state(key, value) VALUES ('retained-test', 'retained')").run();
  h.api.uploadWorker.mockRejectedValueOnce(new CloudflareApiError('orphaned_provisioned_namespace', 400, 100));
  await expect(h.deploy()).rejects.toThrow('orphaned_provisioned_namespace');
  const rejected = (await held())!.value;
  expect(JSON.parse(rejected)).toMatchObject({ step: 'upload-worker', stepState: 'rejected', verificationPending: true });
  const fixed = artifact('0.1.0', 'e'.repeat(64));
  const recovery = await recoverDeployment(h.api, h.metadata, fixed.fingerprint);
  expect(recovery.status).toBe('resume');
  expect((await held())!.value).toBe(rejected);
  const upload = h.api.uploadWorker.getMockImplementation()!;
  h.api.uploadWorker.mockImplementation(async input => {
    const owned = JSON.parse((await held())!.value) as { owner: string };
    expect(owned.owner).not.toBe((JSON.parse(rejected) as { owner: string }).owner);
    expect(owned).toMatchObject({ fingerprint: fixed.fingerprint, verificationPending: true });
    await upload(input);
  });
  await provisionCloudflareDeployment({ api: h.api as never, accountId: h.metadata.accountId!, metadata: h.metadata,
    artifacts: fixed, resumeUpdateValue: recovery.resumeValue, onMetadataChanged: async () => {} });
  expect(await held()).toBeNull();
  expect(await env.DB.prepare("SELECT value FROM maintenance_state WHERE key = 'retained-test'").first()).toEqual({ value: 'retained' });
  expect(h.api.verifyWorkerDeployment).toHaveBeenCalledWith(expect.any(String), fixed.fingerprint);
 });

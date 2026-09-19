import { expect, it, vi } from 'vitest';
import type { CloudflareWorkerSettings } from './cloudflare-api';
import { recoverDeployment } from './deployment-recovery';
import { DEPLOYMENT_FENCE_KEY } from './deployment-fence';
import type { CloudflareDeploymentMetadata } from './deployment-types';

const target: CloudflareDeploymentMetadata = {
    deploymentId: 'a'.repeat(16), accountId: 'account', accountName: 'Account',
    workerName: 'crate-' + 'a'.repeat(16), d1DatabaseId: 'database', d1DatabaseName: 'database',
    r2BucketName: 'bucket', workersSubdomain: 'test', lastDeployedVersion: '0.1.0',
    lastDeployedFingerprint: 'a'.repeat(64),
};
function harness(overrides: Record<string, unknown> = {}) {
    let held: string | null = JSON.stringify({
        worker: target.workerName, owner: '12345678-1234-1234-1234-123456789012', kind: 'update',
        version: '0.1.0', fingerprint: 'a'.repeat(64), recoveryProtocol: 1,
        step: 'upload-worker', stepState: 'confirmed', ...overrides,
    });
    const api = {
        getWorkerSettings: vi.fn(async (): Promise<CloudflareWorkerSettings> => ({
            annotations: { 'workers/message': 'Crate 0.1.0 ' + 'a'.repeat(64) },
            bindings: [{ name: 'DB', type: 'd1', id: 'database' }, { name: 'BUCKET', type: 'r2_bucket', bucket_name: 'bucket' }],
        })),
        queryD1: vi.fn(async (_account: string, _database: string, sql: string, params?: string[]) => {
            if (sql.includes('sqlite_master')) return [{ results: [{ name: 'maintenance_state' }] }];
            if (sql.startsWith('SELECT')) return [{ results: held ? [{ value: held }] : [] }];
            if (sql.startsWith('UPDATE') && held === params?.[2]) { held = params[0]!; return [{ results: [{ value: held }] }]; }
            if (sql.startsWith('DELETE') && held === params?.[1]) {
                held = null;
                return [{ results: [{ key: DEPLOYMENT_FENCE_KEY }] }];
            }
            return [{ results: [] }];
        }),
    };
    return { api, held: () => held, clear: () => { held = null; } };
}
it('conditionally releases a confirmed checkpoint and reports ready on a second check', async () => {
    const h = harness();
    const original = h.held();
    expect((await recoverDeployment(h.api, target)).status).toBe('recovered');
    expect(h.api.queryD1).toHaveBeenLastCalledWith('account', 'database',
        'DELETE FROM maintenance_state WHERE key = ? AND value = ? RETURNING key;', [DEPLOYMENT_FENCE_KEY, original]);
    expect((await recoverDeployment(h.api, target)).status).toBe('ready');
});
it.each([
    { stepState: 'started' }, { recoveryProtocol: undefined }, { step: 'unknown' },
    { kind: 'reset' }, { worker: 'other' }, { owner: 'invalid' },
])('never clears an uncertain or unsupported record: %j', async overrides => {
    const h = harness(overrides);
    const original = h.held();
    expect((await recoverDeployment(h.api, target)).status).toBe('blocked');
    expect(h.held()).toBe(original);
    expect(h.api.queryD1.mock.calls.some(([, , sql]) => sql.startsWith('DELETE'))).toBe(false);
});
it('rejects mismatched live storage before reading or releasing a lock', async () => {
    const h = harness();
    h.api.getWorkerSettings.mockResolvedValue({ annotations: { 'workers/message': '' }, bindings: [] });
    expect((await recoverDeployment(h.api, target)).status).toBe('blocked');
    expect(h.api.queryD1).not.toHaveBeenCalled();
});
it('does not report recovery if the owner advances while checking', async () => {
    const h = harness();
    const query = h.api.queryD1.getMockImplementation()!;
    h.api.queryD1.mockImplementation(async (...args) => {
        if (args[2].startsWith('DELETE')) return [{ results: [] }];
        return query(...args);
    });
    expect((await recoverDeployment(h.api, target)).status).toBe('blocked');
    expect(h.held()).not.toBeNull();
});
it('diagnostics omit arbitrary record contents and credentials', async () => {
    const h = harness({ stepState: 'started', secret: 'do-not-copy', accessToken: 'private' });
    const result = await recoverDeployment(h.api, target);
    expect(result.diagnostics).not.toContain('do-not-copy');
    expect(result.diagnostics).not.toContain('private');
    expect(JSON.parse(result.diagnostics)).toMatchObject({ step: 'upload-worker', liveVersion: '0.1.0' });
});

it.each(['confirmed', 'rejected', 'settled'])('retains a pending %s update for exact-artifact resumption', async stepState => {
    const h = harness({ verificationPending: true, stepState });
    const original = h.held();
    expect((await recoverDeployment(h.api, target, 'b'.repeat(64))).status).toBe('blocked');
    expect(await recoverDeployment(h.api, target, 'a'.repeat(64))).toMatchObject({ status: 'resume', resumeValue: original });
    expect(h.held()).toBe(original);
    expect(h.api.queryD1.mock.calls.some(([, , sql]) => sql.startsWith('DELETE'))).toBe(false);
});

it('offers verification of a confirmed published update even from a different build', async () => {
    const h = harness({ verificationPending: true, step: 'enable-server-address' });
    expect(await recoverDeployment(h.api, target, 'b'.repeat(64))).toMatchObject({ status: 'verify', resumeValue: h.held() });
    expect(h.api.queryD1.mock.calls.some(([, , sql]) => sql.startsWith('DELETE'))).toBe(false);
});

it.each([{ stepState: 'rejected' }, { fingerprint: 'c'.repeat(64) }, { step: 'upload-worker', stepState: 'started' }])('does not verify an uncertain or mismatched publication: %j', async change => {
    const h = harness({ verificationPending: true, step: 'enable-server-address', ...change });
    expect((await recoverDeployment(h.api, target, 'b'.repeat(64))).status).toBe('blocked');
});

it('offers read-and-verify recovery for the fixed address activation without clearing its lock', async () => {
    const h = harness({ verificationPending: true, step: 'enable-server-address', stepState: 'started' });
    const value = h.held();
    expect(await recoverDeployment(h.api, target, 'b'.repeat(64))).toMatchObject({ status: 'verify', resumeValue: value });
    expect(h.held()).toBe(value);
});

it('does not unlock an unconfirmed upload even when the live build matches', async () => {
    const h = harness({ verificationPending: true, stepState: 'started' });
    const original = h.held();
    expect(await recoverDeployment(h.api, target, 'a'.repeat(64))).toMatchObject({ status: 'blocked', title: 'Upload status is uncertain', message: 'Crate couldn’t confirm whether the previous upload finished. Continuing now could let it overwrite a newer update.' });
    expect(h.held()).toBe(original);
    expect(h.api.queryD1.mock.calls.some(([, , sql]) => /^(UPDATE|DELETE)/.test(sql))).toBe(false);
});

const uploadTag = 'crate-12345678-1234-1234-1234-123456789012';
it('recovers a lost upload response from its exact provider receipt while retaining the lock', async () => {
    const h = harness({ verificationPending: true, stepState: 'started', uploadTag });
    const settings = await h.api.getWorkerSettings();
    h.api.getWorkerSettings.mockResolvedValue({ ...settings, annotations: { ...settings.annotations, 'workers/tag': uploadTag } });
    const result = await recoverDeployment(h.api, target, 'a'.repeat(64));
    expect(result).toMatchObject({ status: 'resume', resumeValue: h.held() });
    expect(JSON.parse(h.held()!)).toMatchObject({ stepState: 'confirmed', verificationPending: true, uploadTag });
    expect(h.api.queryD1.mock.calls.some(([, , sql]) => sql.startsWith('DELETE'))).toBe(false);
    expect((await recoverDeployment(h.api, target, 'a'.repeat(64))).status).toBe('resume');
});
it.each(['crate', 'crate-aaaaaaaa-1234-1234-1234-123456789012', undefined])('never treats another upload tag as a receipt: %s', async liveTag => {
    const h = harness({ verificationPending: true, stepState: 'started', uploadTag });
    const original = h.held();
    const settings = await h.api.getWorkerSettings();
    h.api.getWorkerSettings.mockResolvedValue({ ...settings, annotations: { ...settings.annotations, 'workers/tag': liveTag } });
    expect((await recoverDeployment(h.api, target, 'a'.repeat(64))).status).toBe('blocked');
    expect(h.held()).toBe(original);
});
it('does not acknowledge a receipt when ownership changes concurrently', async () => {
    const h = harness({ verificationPending: true, stepState: 'started', uploadTag });
    const settings = await h.api.getWorkerSettings();
    h.api.getWorkerSettings.mockResolvedValue({ ...settings, annotations: { ...settings.annotations, 'workers/tag': uploadTag } });
    const query = h.api.queryD1.getMockImplementation()!;
    h.api.queryD1.mockImplementation(async (...args) => args[2].startsWith('UPDATE') ? [{ results: [] }] : query(...args));
    expect((await recoverDeployment(h.api, target, 'a'.repeat(64))).status).toBe('blocked');
    expect(JSON.parse(h.held()!)).toMatchObject({ stepState: 'started' });
});

it.each([
    { fingerprint: 'b'.repeat(64) }, { version: '9.0.0' },
    { verificationPending: false }, { uploadTag: 'crate' },
])('keeps mismatched receipt metadata locked: %j', async overrides => {
    const h = harness({ verificationPending: true, stepState: 'started', uploadTag, ...overrides });
    const original = h.held();
    const settings = await h.api.getWorkerSettings();
    h.api.getWorkerSettings.mockResolvedValue({ ...settings, annotations: { ...settings.annotations, 'workers/tag': uploadTag } });
    expect((await recoverDeployment(h.api, target, 'a'.repeat(64))).status).toBe('blocked');
    expect(h.held()).toBe(original);
});

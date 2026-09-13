import { expect, it, vi } from 'vitest';
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
        getWorkerSettings: vi.fn(async () => ({
            annotations: { 'workers/message': 'Crate 0.1.0 ' + 'a'.repeat(64) },
            bindings: [{ name: 'DB', type: 'd1', id: 'database' }, { name: 'BUCKET', type: 'r2_bucket', bucket_name: 'bucket' }],
        })),
        queryD1: vi.fn(async (_account: string, _database: string, sql: string, params?: string[]) => {
            if (sql.includes('sqlite_master')) return [{ results: [{ name: 'maintenance_state' }] }];
            if (sql.startsWith('SELECT')) return [{ results: held ? [{ value: held }] : [] }];
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

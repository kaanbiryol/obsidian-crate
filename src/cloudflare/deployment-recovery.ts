import { SERVER_RELEASE } from './database-upgrades';
import { DEPLOYMENT_FENCE_KEY } from './deployment-fence';
import { CloudflareApiError, type CloudflareApiClient, type CloudflareWorkerSettings } from './cloudflare-api';
import type { CloudflareDeploymentMetadata } from './deployment-types';

type RecoveryApi = Pick<CloudflareApiClient, 'queryD1' | 'getWorkerSettings'>;
export interface DeploymentRecoveryResult {
    status: 'ready' | 'recovered' | 'blocked' | 'resume' | 'completed';
    resumeValue?: string;
    message: string;
    diagnostics: string;
}
const confirmedSteps = new Set(['acquire-deployment', 'prepare-database', 'create-file-bucket', 'initialize-database', 'create-server-address', 'upload-worker', 'configure-maintenance', 'enable-server-address', 'record-release', 'verify-deployment']);

/** A confirmed checkpoint can be removed conditionally: the old updater must CAS
 * it to "started" before dispatching its next mutation. Never steal a started step. */
export async function recoverDeployment(api: RecoveryApi, target: CloudflareDeploymentMetadata, fingerprint?: string): Promise<DeploymentRecoveryResult> {
    if (!target.accountId || !target.d1DatabaseId || target.reset) throw new Error('Select the original server and finish any pending reset or deletion first.');
    const account = target.accountId;
    const database = target.d1DatabaseId;
    const report: Record<string, unknown> = { worker: target.workerName, database, checkedAt: new Date().toISOString() };
    const result = (status: DeploymentRecoveryResult['status'], message: string): DeploymentRecoveryResult =>
        ({ status, message, diagnostics: JSON.stringify({ ...report, status }, null, 2) });
    let settings: CloudflareWorkerSettings | null;
    try { settings = await api.getWorkerSettings(account, target.workerName); }
    catch (error) {
        if (!(error instanceof CloudflareApiError && error.status === 404)) throw error;
        settings = null; // First installation may stop before creating the Worker.
    }
    const db = settings?.bindings?.find(binding => binding.name === 'DB');
    const bucket = settings?.bindings?.find(binding => binding.name === 'BUCKET');
    if (settings && (db?.type !== 'd1' || db.id !== database || bucket?.type !== 'r2_bucket' || bucket.bucket_name !== target.r2BucketName)) {
        return result('blocked', 'The live server uses different storage. Recovery stopped without changing it.');
    }
    const message = settings?.annotations?.['workers/message'] ?? '';
    const build = /^Crate (\d+\.\d+\.\d+) ([a-f0-9]{64})$/.exec(message);
    if (settings && !build) return result('blocked', 'The live server could not be identified as a supported Crate deployment.');
    report.liveVersion = build?.[1];
    report.liveFingerprint = build?.[2];
    const tables = (await api.queryD1(account, database,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_state';")).flatMap(row => row.results ?? []);
    if (!tables.length) return result('ready', 'No interrupted update is blocking this server.');
    const rows = (await api.queryD1(account, database,
        'SELECT value FROM maintenance_state WHERE key = ?;', [DEPLOYMENT_FENCE_KEY])).flatMap(row => row.results ?? []);
    if (!rows.length) return result('ready', 'No interrupted update is blocking this server.');
    if (rows.length !== 1 || typeof rows[0]?.value !== 'string') return result('blocked', 'The saved operation record is invalid. Copy diagnostics for support.');
    const value = rows[0].value;
    let record: Record<string, unknown>;
    try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        record = parsed as Record<string, unknown>;
    } catch { return result('blocked', 'The saved operation record is unreadable. Copy diagnostics for support.'); }
    // Only copy bounded operation metadata, never arbitrary database contents.
    for (const key of ['owner', 'kind', 'startedAt', 'step', 'stepState', 'version', 'fingerprint']) {
        if (typeof record[key] === 'string') report[key] = record[key].slice(0, 200);
    }
    if (record.worker !== target.workerName || record.kind !== 'update' || typeof record.owner !== 'string'
        || !/^[a-f0-9-]{36}$/.test(record.owner)) {
        return result('blocked', 'This record belongs to another operation. No lock was cleared.');
    }
    if (record.recoveryProtocol !== 1 || !['confirmed', 'rejected', 'settled'].includes(String(record.stepState)) || !confirmedSteps.has(String(record.step)) && !SERVER_RELEASE.migrations.some(migration => record.step === `migrate-${migration.id}`)) {
        return result('blocked', 'Cloudflare may still be processing the interrupted request. Crate cannot safely unlock it yet. Copy diagnostics for support; no server data was changed.');
    }
    if (record.verificationPending === true) {
        if (!fingerprint || fingerprint !== record.fingerprint) return result('blocked', 'Resume this update with the exact plugin build that started it. No lock was cleared.');
        return { ...result('resume', 'The confirmed update can resume under new ownership.'), resumeValue: value };
    }
    const removed = (await api.queryD1(account, database,
        'DELETE FROM maintenance_state WHERE key = ? AND value = ? RETURNING key;', [DEPLOYMENT_FENCE_KEY, value])).flatMap(row => row.results ?? []);
    if (removed.length !== 1 || removed[0]?.key !== DEPLOYMENT_FENCE_KEY) {
        return result('blocked', 'The operation changed during the check. Let it finish, then check again.');
    }
    return result('recovered', 'The confirmed operation was recovered. You can now retry the server update.');
}

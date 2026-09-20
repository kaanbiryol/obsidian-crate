import { SERVER_RELEASE } from './database-upgrades';
import { DEPLOYMENT_FENCE_KEY, isPendingAddressActivation, isRejectedWorkerUpload } from './deployment-fence';
import { CloudflareApiError, type CloudflareApiClient, type CloudflareWorkerSettings } from './cloudflare-api';
import type { CloudflareDeploymentMetadata } from './deployment-types';

type RecoveryApi = Pick<CloudflareApiClient, 'queryD1' | 'getWorkerSettings'>;
export interface DeploymentRecoveryResult {
    status: 'ready' | 'recovered' | 'blocked' | 'resume' | 'verify' | 'completed';
    title?: string;
    resumeValue?: string;
    message: string;
    diagnostics: string;
}
const confirmedSteps = new Set(['acquire-deployment', 'prepare-database', 'create-file-bucket', 'initialize-database', 'create-server-address', 'upload-worker', 'configure-maintenance', 'enable-server-address', 'record-release', 'verify-deployment']);

/** A confirmed checkpoint can be removed conditionally: the old updater must CAS
 * it to "started" before dispatching its next mutation. Pending address activation
 * has a separate read-and-verify recovery path; other started steps stay blocked. */
export async function recoverDeployment(api: RecoveryApi, target: CloudflareDeploymentMetadata, fingerprint?: string): Promise<DeploymentRecoveryResult> {
    if (!target.accountId || !target.d1DatabaseId || target.reset) throw new Error('Select the original server and finish any pending reset or deletion first.');
    const account = target.accountId;
    const database = target.d1DatabaseId;
    const report: Record<string, unknown> = { worker: target.workerName, database, checkedAt: new Date().toISOString(), currentFingerprint: fingerprint };
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
    let value = rows[0].value;
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
    // A unique tag identifies this single non-retried dispatch, unlike a build
    // fingerprint shared by repeated uploads. Its presence on the live version
    // establishes publication even if the response/checkpoint was lost.
    if (record.recoveryProtocol === 1 && record.verificationPending === true
        && record.step === 'upload-worker' && record.stepState === 'started'
        && typeof record.uploadTag === 'string'
        && /^crate-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(record.uploadTag)
        && settings?.annotations?.['workers/tag'] === record.uploadTag
        && build?.[1] === record.version && build?.[2] === record.fingerprint
        && fingerprint === record.fingerprint) {
        const confirmed = JSON.stringify({ ...record, stepState: 'confirmed' });
        const changed = (await api.queryD1(account, database,
            'UPDATE maintenance_state SET value = ? WHERE key = ? AND value = ? RETURNING value;',
            [confirmed, DEPLOYMENT_FENCE_KEY, value])).flatMap(row => row.results ?? []);
        if (changed.length !== 1 || changed[0]?.value !== confirmed) {
            return result('blocked', 'The operation changed during the check. Check again to read its latest status.');
        }
        value = confirmed;
        record = { ...record, stepState: 'confirmed' };
        report.stepState = 'confirmed';
    }
    const pendingAddress = isPendingAddressActivation(record);
    const settled = ['confirmed', 'rejected', 'settled'].includes(String(record.stepState));
    const knownStep = confirmedSteps.has(String(record.step)) || SERVER_RELEASE.migrations.some(migration => record.step === `migrate-${migration.id}`);
    if (record.recoveryProtocol === 1 && record.step === 'upload-worker' && record.stepState === 'started') {
        return { ...result('blocked', 'Crate couldn’t confirm whether the previous upload finished. Continuing now could let it overwrite a newer update.'), title: 'Upload status is uncertain' };
    }
    if (record.recoveryProtocol !== 1 || !(settled || pendingAddress) || !knownStep) {
        return result('blocked', 'Cloudflare has not confirmed that the interrupted request finished. Crate cannot safely resume this update yet.');
    }
    if (record.verificationPending === true) {
        if (build?.[2] === record.fingerprint && build?.[1] === record.version
            && (pendingAddress || record.stepState === 'confirmed' && ['enable-server-address', 'record-release', 'verify-deployment'].includes(String(record.step))
                || record.completionOnly === true && ['acquire-deployment', 'record-release', 'verify-deployment'].includes(String(record.step)))) {
            return { ...result('verify', 'The published update can be verified under new ownership.'), resumeValue: value };
        }
        if (pendingAddress) return result('blocked', 'The pending address activation belongs to a different published build. No lock was cleared.');
        if (fingerprint && isRejectedWorkerUpload(record)) {
            return { ...result('resume', 'The rejected upload can be replaced by this build under new ownership.'), resumeValue: value };
        }
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

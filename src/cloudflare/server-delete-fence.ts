import { DEPLOYMENT_FENCE_KEY, DeploymentRecoveryRequiredError } from './deployment-fence';
import type { CloudflareDeploymentMetadata } from './deployment-types';
import { assertDeletionHelper, deletionWorkerSettings, type DeleteApi } from './server-delete-ownership';

/** Destruction can supersede any settled operation, without interpreting its release or schema. */
export async function inspectTerminalDeletionFence(api: DeleteApi, metadata: CloudflareDeploymentMetadata): Promise<string | undefined> {
	const account = metadata.accountId!, database = metadata.d1DatabaseId!;
	await api.queryD1(account, database,
		"CREATE TABLE IF NOT EXISTS maintenance_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));");
	const rows = (await api.queryD1(account, database, 'SELECT value FROM maintenance_state WHERE key = ?;', [DEPLOYMENT_FENCE_KEY]))
		.flatMap(result => result.results ?? []);
	if (!rows.length) return undefined;
	let record: Record<string, unknown> | undefined;
	const blocked = () => {
		const details = record ? Object.fromEntries(['owner', 'worker', 'kind', 'recoveryProtocol', 'step', 'stepState', 'resetId', 'uploadTag']
			.filter(key => record?.[key] !== undefined).map(key => [key, record?.[key]])) : null;
		return new DeploymentRecoveryRequiredError(`A previous Cloudflare request may still be running. Deletion cannot start while that request could recreate this server. Let it finish, or review its recorded outcome before resuming deletion.${details ? `\n\nRecorded operation:\n${JSON.stringify(details, null, 2)}` : ''}`);
	};
	if (rows.length !== 1 || typeof rows[0]?.value !== 'string') throw blocked();
	const value = rows[0].value;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw blocked();
		record = parsed as Record<string, unknown>;
	} catch { throw blocked(); }
	if (record.worker !== metadata.workerName || typeof record.owner !== 'string' || !record.owner) throw blocked();
	if (['confirmed', 'rejected', 'settled'].includes(String(record.stepState))) return value;
	// Only this terminal workflow can repeat deletion while a request is still
	// in flight. It never recreates the original Worker, bucket, or database.
	if (record.kind !== 'delete' || record.resetId !== metadata.deletion?.id || record.stepState !== 'started') throw blocked();
	if (['delete-worker', 'deleteR2Object', 'deleteR2Objects', 'deleteR2Bucket', 'deleteD1Database', 'enable-deletion-address'].includes(String(record.step))) return value;
	if (record.step === 'upload-worker' && typeof record.uploadTag === 'string') {
		const helper = await deletionWorkerSettings(api, account, metadata.deletion!.helperName);
		if (helper) {
			assertDeletionHelper(helper, metadata);
			if (helper.annotations?.['workers/tag'] === record.uploadTag) return value;
		}
	}
	throw blocked();
}

import { DEPLOYMENT_FENCE_KEY, DeploymentRecoveryRequiredError } from './deployment-fence';
import type { CloudflareDeploymentMetadata } from './deployment-types';
import { assertWorkerTarget, type ResetApi } from './reset-ownership';

/** Called only after reset's complete ownership preflight. Never used by rebuilds. */
export async function inspectResumableDeletion(api: ResetApi, metadata: CloudflareDeploymentMetadata): Promise<string | undefined> {
	const checkpoint = metadata.reset;
	if (!checkpoint?.deleteOnly || checkpoint.phase !== 'clearing' || !metadata.accountId
		|| checkpoint.databaseId !== metadata.d1DatabaseId) return undefined;
	const rows = (await api.queryD1(metadata.accountId, checkpoint.databaseId,
		'SELECT value FROM maintenance_state WHERE key = ?;', [DEPLOYMENT_FENCE_KEY])).flatMap(result => result.results ?? []);
	if (!rows.length) return undefined;
	const blocked = () => new DeploymentRecoveryRequiredError('The interrupted deletion cannot be resumed automatically. Its recorded step needs review; no lock was cleared.');
	if (rows.length !== 1 || typeof rows[0]?.value !== 'string') throw blocked();
	const value = rows[0].value;
	let record: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw blocked();
		record = parsed as Record<string, unknown>;
	} catch { throw blocked(); }
	if (record.worker !== metadata.workerName || record.kind !== 'delete' || record.recoveryProtocol !== 1
		|| typeof record.owner !== 'string' || !/^[a-f0-9-]{36}$/.test(record.owner)
		|| record.verificationPending === true) throw blocked();
	const confirmed = record.stepState === 'confirmed'
		&& ['retireCrateWorker', 'deleteR2Object', 'deleteR2Bucket'].includes(String(record.step));
	// A late object DELETE can only remove data this same permanent deletion is
	// already removing. The retirement Worker blocks writers, and delete-only never
	// rebuilds these resources. Do not generalize this to publication or reset.
	// Legacy records omit the object key; re-list the verified bucket on resume.
	const repeatable = record.stepState === 'started' && record.step === 'deleteR2Object';
	if (!confirmed && !repeatable) throw blocked();
	const worker = await api.getWorkerSettings(metadata.accountId, metadata.workerName);
	assertWorkerTarget(worker, metadata, true);
	if (worker.annotations?.['workers/message'] !== `Crate reset ${checkpoint.id}`) throw blocked();
	const bucket = await api.getR2Bucket(metadata.accountId, metadata.r2BucketName);
	if (bucket && (bucket.name !== metadata.r2BucketName || bucket.creation_date !== checkpoint.bucketCreatedAt)) throw blocked();
	return value;
}

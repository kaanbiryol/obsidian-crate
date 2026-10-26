import { createFenceTable, DeploymentRecoveryRequiredError, isSettledStep, parseFenceRecord, readStoredFence, REPEATABLE_DELETION_STEPS } from '../deployment/fence';
import type { CloudflareDeploymentMetadata } from '../deployment/types';
import { assertDeletionHelper, deletionWorkerSettings, type DeleteApi } from './delete-ownership';

/** Destruction can supersede any settled operation, without interpreting its release or schema. */
export async function inspectTerminalDeletionFence(api: DeleteApi, metadata: CloudflareDeploymentMetadata): Promise<string | undefined> {
	const account = metadata.accountId!, database = metadata.d1DatabaseId!;
	await createFenceTable(api, account, database);
	const stored = await readStoredFence(api, account, database);
	if (stored.state === 'none') return undefined;
	let record: Record<string, unknown> | undefined;
	const blocked = () => {
		const details = record ? Object.fromEntries(['owner', 'worker', 'kind', 'recoveryProtocol', 'step', 'stepState', 'resetId', 'uploadTag']
			.filter(key => record?.[key] !== undefined).map(key => [key, record?.[key]])) : null;
		return new DeploymentRecoveryRequiredError(`A previous Cloudflare request may still be running. Deletion cannot start while that request could recreate this server. Let it finish, or review its recorded outcome before resuming deletion.${details ? `\n\nRecorded operation:\n${JSON.stringify(details, null, 2)}` : ''}`);
	};
	if (stored.state !== 'held') throw blocked();
	const value = stored.value;
	record = parseFenceRecord(value);
	if (!record) throw blocked();
	if (record.worker !== metadata.workerName || typeof record.owner !== 'string' || !record.owner) throw blocked();
	if (isSettledStep(record)) return value;
	// Only this terminal workflow can repeat deletion while a request is still
	// in flight. It never recreates the original Worker, bucket, or database.
	if (record.kind !== 'delete' || record.resetId !== metadata.deletion?.id || record.stepState !== 'started') throw blocked();
	if ((REPEATABLE_DELETION_STEPS as readonly string[]).includes(String(record.step))) return value;
	if (record.step === 'upload-worker' && typeof record.uploadTag === 'string') {
		const helper = await deletionWorkerSettings(api, account, metadata.deletion!.helperName);
		if (helper) {
			assertDeletionHelper(helper, metadata);
			if (helper.annotations?.['workers/tag'] === record.uploadTag) return value;
		}
	}
	throw blocked();
}

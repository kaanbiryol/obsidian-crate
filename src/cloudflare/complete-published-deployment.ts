import type { CloudflareApiClient } from './cloudflare-api';
import type { CloudflareDeploymentArtifacts } from './deployment-artifacts';
import type { CloudflareDeploymentMetadata } from './deployment-types';
import { inspectDeploymentDatabase, recordDeploymentRelease } from './deployment-database';
import { SERVER_RELEASE } from './database-upgrades';
import { type DeploymentFenceRecord, DeploymentRecoveryRequiredError, isPendingAddressActivation, withDeploymentFence } from './deployment-fence';

/** Verify an already-published update and its address. Never upload a replacement build. */
export async function completePublishedDeployment(
	api: Pick<CloudflareApiClient, 'getWorkerSettings' | 'getWorkerSubdomain' | 'queryD1' | 'verifyPublishedWorkerDeployment'>,
	target: CloudflareDeploymentMetadata,
	artifacts: CloudflareDeploymentArtifacts,
	value: string,
): Promise<void> {
	const record = JSON.parse(value) as DeploymentFenceRecord;
	const finalStep = record.stepState === 'confirmed' && ['enable-server-address', 'record-release', 'verify-deployment'].includes(record.step ?? '');
	const retry = record.completionOnly === true && ['confirmed', 'rejected', 'settled'].includes(record.stepState ?? '')
		&& ['acquire-deployment', 'record-release', 'verify-deployment'].includes(record.step ?? '');
	if (!target.accountId || !target.d1DatabaseId || target.reset || record.kind !== 'update'
		|| record.worker !== target.workerName || record.recoveryProtocol !== 1 || record.verificationPending !== true
		|| !record.fingerprint || !/^[a-f0-9]{64}$/.test(record.fingerprint) || !/^\d+\.\d+\.\d+$/.test(record.version)
		|| !(finalStep || retry || isPendingAddressActivation(record))) throw new Error('This update is not ready for publication verification.');
	const accountId = target.accountId;
	const databaseId = target.d1DatabaseId;
	const fingerprint = record.fingerprint;
	// Resolve the address from the selected server, never from the operation record.
	if (!/^crate-[a-f0-9]{16}$/.test(target.workerName) || !/^[a-z0-9-]+$/.test(target.workersSubdomain ?? '')) {
		throw new Error('The saved server address is invalid.');
	}
	const publishedArtifacts = { ...artifacts, version: record.version, fingerprint };
	const verifyAddress = async () => {
		const address = await api.getWorkerSubdomain(accountId, target.workerName);
		if (address.enabled !== true || address.previews_enabled !== false) {
			throw new DeploymentRecoveryRequiredError('Cloudflare has not confirmed the expected server address settings (enabled, with preview URLs disabled). The update lock remains held.');
		}
	};
	// Inspect before replacing an unconfirmed activation, then recheck under our
	// ownership. No activation request is retried, and the old owner cannot advance.
	if (isPendingAddressActivation(record)) await verifyAddress();
	await withDeploymentFence({ api, accountId, databaseId, resumeUpdateValue: value,
		record: { worker: target.workerName, kind: 'update', version: record.version, fingerprint,
			verificationPending: true, completionOnly: true },
	}, async fence => {
		await verifyAddress();
		const settings = await api.getWorkerSettings(accountId, target.workerName);
		const db = settings.bindings?.find(binding => binding.name === 'DB');
		const bucket = settings.bindings?.find(binding => binding.name === 'BUCKET');
		if (settings.annotations?.['workers/message'] !== `Crate ${record.version} ${fingerprint}`
			|| db?.type !== 'd1' || db.id !== databaseId || bucket?.type !== 'r2_bucket' || bucket.bucket_name !== target.r2BucketName) {
			throw new Error('The published Worker or its storage changed. Recovery stopped.');
		}
		const schema = { api, accountId, databaseId, artifacts: publishedArtifacts };
		if (await inspectDeploymentDatabase(schema) !== SERVER_RELEASE.schemaVersion) {
			throw new Error('The published database needs a different schema. Use its matching recovery build.');
		}
		await api.queryD1(accountId, databaseId, 'SELECT path, storage_key FROM files LIMIT 1; SELECT id FROM auth_tokens LIMIT 1;');
		const live = await api.verifyPublishedWorkerDeployment(`https://${target.workerName}.${target.workersSubdomain}.workers.dev`, fingerprint);
		const releases = (await api.queryD1(accountId, databaseId, 'SELECT revision, fingerprint FROM crate_release WHERE id = 1;')).flatMap(row => row.results ?? []);
		if (live.schemaVersion !== SERVER_RELEASE.schemaVersion || !Number.isSafeInteger(live.revision) || live.revision < 1 || live.revision > SERVER_RELEASE.revision
			|| releases.some(saved => Number(saved.revision) > live.revision || saved.revision === live.revision && saved.fingerprint !== fingerprint)) {
			throw new Error('The published release conflicts with the saved database release. Recovery stopped.');
		}
		await recordDeploymentRelease(schema, fence, live.revision);
		await fence.completeVerification();
	});
	target.lastDeployedVersion = record.version;
	target.lastDeployedFingerprint = fingerprint;
}

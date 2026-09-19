import { readVaultName } from './vault-name';
import { inspectDeploymentDatabase, prepareDeploymentDatabase, recordDeploymentRelease } from './deployment-database';
import { SERVER_RELEASE, type DatabaseMigration } from './database-upgrades';
import type { CloudflareDeploymentMetadata } from './deployment-types';
import { CloudflareApiClient, CloudflareApiError } from './cloudflare-api';
import type { CloudflareDeploymentArtifacts } from './deployment-artifacts';
import { randomHex } from './pkce';
import { deployedArtifact } from './deployment-discovery';
import { assertDeploymentIsNotDowngrade } from './deployment-update';
import { withDeploymentFence, type DeploymentFence } from './deployment-fence';

async function ensureD1Database(
	api: CloudflareApiClient,
	accountId: string,
	metadata: CloudflareDeploymentMetadata,
): Promise<string> {
	if (metadata.d1DatabaseId) {
		const existingById = await api.getD1Database(accountId, metadata.d1DatabaseId);
		if (existingById?.uuid) {
			const named = await api.findD1Database(accountId, metadata.d1DatabaseName);
			if (existingById.name !== metadata.d1DatabaseName || named?.uuid !== existingById.uuid) throw new Error('The deployment database identity is ambiguous or changed. Reconnect to the intended server.');
			return existingById.uuid;
		}
    throw new Error('The saved server database is missing. Restore its data or explicitly create a new server.');
	}

	const existingByName = await api.findD1Database(accountId, metadata.d1DatabaseName);
	if (existingByName?.uuid) return existingByName.uuid;
	let created;
	try { created = await api.createD1Database(accountId, metadata.d1DatabaseName); }
	catch (error) {
		// Cloudflare's D1 create endpoint rejects an existing account/name with
		// 7502 (also handled by Wrangler). Never infer a completed creation from
		// a transport failure or an unrelated API error.
		if (!(error instanceof CloudflareApiError && error.code === 7502 && error.status >= 400 && error.status < 500)) throw error;
		const existing = await api.findD1Database(accountId, metadata.d1DatabaseName);
		if (!existing?.uuid) throw error;
		return existing.uuid;
	}
	if (!created.uuid) throw new Error('Cloudflare did not return the new D1 database ID');
	const named = await api.findD1Database(accountId, metadata.d1DatabaseName);
	if (named?.uuid !== created.uuid) throw new Error('The deployment database identity changed during creation. Inspect the deployment resources before retrying.');
	return created.uuid;
}

async function ensureR2Bucket(
	api: CloudflareApiClient,
	accountId: string,
	bucketName: string,
  allowCreate: boolean,
	fence: DeploymentFence,
): Promise<void> {
	try {
		if (await api.getR2Bucket(accountId, bucketName)) return;
    if (!allowCreate) throw new Error('The saved server file bucket is missing. Restore its data or explicitly create a new server.');
		await fence.mutate(() => api.createR2Bucket(accountId, bucketName), 'create-file-bucket');
	} catch (error) {
		if (error instanceof CloudflareApiError && error.code === 10042) {
			throw new Error(
				'R2 is not active for this Cloudflare account. Enable an R2 subscription in the Cloudflare dashboard, then select Connect with Cloudflare again.',
			);
		}
		throw error;
	}
}

async function checkRemoteDeployment(input: { api: CloudflareApiClient; accountId: string; metadata: CloudflareDeploymentMetadata; artifacts: CloudflareDeploymentArtifacts }): Promise<string | null> {
	try {
		const settings = await input.api.getWorkerSettings(input.accountId, input.metadata.workerName);
		const message = settings.annotations?.['workers/message'];
		const ownResetStub = input.metadata.reset?.phase === 'rebuilding' && message === `Crate reset ${input.metadata.reset.id}`;
		if (message?.startsWith('Crate reset ') && !ownResetStub) throw new Error('This server is being reset or deleted. Finish that operation before updating.');
		if (!ownResetStub) assertDeploymentIsNotDowngrade(deployedArtifact(settings).version, input.artifacts.version);
		const database = settings.bindings?.filter(binding => binding.type === 'd1');
		const bucket = settings.bindings?.filter(binding => binding.type === 'r2_bucket');
		const expectedDatabase = ownResetStub ? input.metadata.reset!.databaseId : input.metadata.d1DatabaseId;
		if (!message?.startsWith('Crate ') || database?.length !== 1 || database[0]?.name !== 'DB'
			|| !database[0]?.id || expectedDatabase && database[0].id !== expectedDatabase
			|| bucket?.length !== 1 || bucket[0]?.name !== 'BUCKET' || bucket[0]?.bucket_name !== input.metadata.r2BucketName) {
			throw new Error('The live Worker bindings do not match this deployment. Reconnect to the correct server before updating.');
		}
		const vaultName = readVaultName(settings);
		if (vaultName) input.metadata.vaultName = vaultName;
		return JSON.stringify([message, database[0].id, bucket[0].bucket_name, vaultName]);
	} catch (error) {
		if (!(error instanceof CloudflareApiError && error.status === 404)) throw error;
		return null;
	}
}

async function ensureWorkersSubdomain(
	api: CloudflareApiClient,
	accountId: string,
	metadata: CloudflareDeploymentMetadata,
	fence: DeploymentFence,
): Promise<string> {
	const existing = await api.getWorkersSubdomain(accountId);
	if (existing) return existing;

	const candidates = [
		metadata.workersSubdomain,
		`crate-${metadata.deploymentId}`,
		`crate-${metadata.deploymentId}-${randomHex(2)}`,
	].filter((value): value is string => Boolean(value));
	let lastError: unknown = null;
	for (const candidate of candidates) {
		try {
			return await fence.mutate(() => api.createWorkersSubdomain(accountId, candidate), 'create-server-address');
		} catch (error) {
			if (!(error instanceof CloudflareApiError && error.status >= 400 && error.status < 500 && error.status !== 408)) throw error;
			lastError = error;
		}
	}
	if (lastError instanceof Error) throw lastError;
	throw new Error('Cloudflare could not create a workers.dev subdomain');
}

export async function provisionCloudflareDeployment(input: {
	api: CloudflareApiClient;
	accountId: string;
	metadata: CloudflareDeploymentMetadata;
	artifacts: CloudflareDeploymentArtifacts;
	onMetadataChanged: () => Promise<void>;
	onProgress?: (message: string) => void;
  beforeDatabaseUpgrade?: (migrations: readonly DatabaseMigration[]) => Promise<void>;
  resumeUpdateValue?: string;
}): Promise<string> {
  if (input.resumeUpdateValue) {
    const record = JSON.parse(input.resumeUpdateValue) as Record<string, unknown>;
    if (record.kind !== 'update' || record.worker !== input.metadata.workerName
      || record.fingerprint !== input.artifacts.fingerprint || record.recoveryProtocol !== 1
      || !['confirmed', 'rejected', 'settled'].includes(String(record.stepState))) throw new Error('This update cannot be safely resumed by this build.');
  }
	const previousVaultName = input.metadata.vaultName;
	const expectedRemote = await checkRemoteDeployment(input);
	input.onProgress?.('Preparing the server database…');
	const databaseId = await ensureD1Database(input.api, input.accountId, input.metadata);
	if (!databaseId) throw new Error('Cloudflare did not return the new D1 database ID');
	if (input.metadata.d1DatabaseId !== databaseId) {
		input.metadata.d1DatabaseId = databaseId;
		await input.onMetadataChanged();
	}

	const schemaInput = {
		api: input.api,
		accountId: input.accountId,
		databaseId,
		artifacts: input.artifacts,
	};
	await inspectDeploymentDatabase(schemaInput);
	return withDeploymentFence({ api: input.api, accountId: input.accountId, databaseId,
		record: { worker: input.metadata.workerName, kind: 'update', version: input.artifacts.version, fingerprint: input.artifacts.fingerprint, verificationPending: Boolean(input.resumeUpdateValue) },
    resumeUpdateValue: input.resumeUpdateValue,
	}, async fence => {
		// Recheck after acquiring ownership: another device may have completed an
		// update after the initial read but before this attempt acquired the fence.
		if (await checkRemoteDeployment(input) !== expectedRemote) throw new Error('The server changed while this update was starting. Refresh its deployment status before authorizing another update.');
		const schemaVersion = await inspectDeploymentDatabase(schemaInput);
		input.onProgress?.('Preparing the remote file bucket…');
		await ensureR2Bucket(input.api, input.accountId, input.metadata.r2BucketName, schemaVersion === null, fence);
		await prepareDeploymentDatabase(schemaInput, schemaVersion, fence, input.beforeDatabaseUpgrade);
    await fence.checkpoint('prepare-database');
		const workersSubdomain = await ensureWorkersSubdomain(input.api, input.accountId, input.metadata, fence);
		input.onProgress?.('Uploading the Worker and web app to Cloudflare…');
    fence.requireVerification();
		await fence.uploadWorker(uploadTag => input.api.uploadWorker({
      uploadTag,
			publicOrigin: `https://${input.metadata.workerName}.${workersSubdomain}.workers.dev`,
			accountId: input.accountId,
			workerName: input.metadata.workerName,
			vaultName: input.metadata.vaultName,
			artifacts: input.artifacts,
			d1DatabaseId: databaseId,
			r2BucketName: input.metadata.r2BucketName,
		}));
		input.onProgress?.('Configuring server maintenance…');
		await fence.mutate(() => input.api.updateWorkerSchedules(
			input.accountId,
			input.metadata.workerName,
			[],
		), 'configure-maintenance');

		input.onProgress?.('Enabling the server address…');
		if (input.metadata.workersSubdomain !== workersSubdomain) {
			input.metadata.workersSubdomain = workersSubdomain;
			await input.onMetadataChanged();
		}
		const address = await input.api.getWorkerSubdomain(input.accountId, input.metadata.workerName);
		if (address.enabled && !address.previews_enabled) {
			await fence.checkpoint('enable-server-address');
		} else {
			await fence.mutate(() => input.api.enableWorkerSubdomain(input.accountId, input.metadata.workerName), 'enable-server-address');
		}

    input.onProgress?.('Verifying the updated server…');
    const settings = await input.api.getWorkerSettings(input.accountId, input.metadata.workerName);
    if (deployedArtifact(settings).fingerprint !== input.artifacts.fingerprint) throw new Error('The expected Worker is not live yet. Check and recover this update.');
    await checkRemoteDeployment(input);
    const versions = (await input.api.queryD1(input.accountId, databaseId, 'SELECT version FROM crate_schema WHERE id = 1;')).flatMap(result => result.results ?? []);
    if (versions.length !== 1 || versions[0]?.version !== SERVER_RELEASE.schemaVersion) throw new Error('The updated database could not be verified.');
    await input.api.queryD1(input.accountId, databaseId, 'SELECT path, storage_key FROM files LIMIT 1; SELECT id FROM auth_tokens LIMIT 1;');
    await input.api.verifyWorkerDeployment(`https://${input.metadata.workerName}.${workersSubdomain}.workers.dev`, input.artifacts.fingerprint);
    await recordDeploymentRelease(schemaInput, fence);
    await fence.completeVerification();

		if (
			input.metadata.lastDeployedVersion !== input.artifacts.version
			|| input.metadata.lastDeployedFingerprint !== input.artifacts.fingerprint
			|| input.metadata.vaultName !== previousVaultName
		) {
			input.metadata.lastDeployedVersion = input.artifacts.version;
			input.metadata.lastDeployedFingerprint = input.artifacts.fingerprint;
			await input.onMetadataChanged();
		}
		return `https://${input.metadata.workerName}.${workersSubdomain}.workers.dev`;
	});
}

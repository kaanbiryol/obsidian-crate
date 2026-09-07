import type { CloudflareDeploymentMetadata } from './deployment-types';
import { assertDeploymentIsNotDowngrade } from './deployment-update';
import { deployedArtifact } from './deployment-discovery';
import { randomHex } from './pkce';
import { assertWorkerTarget, assertUnsharedResources, assertOwnedNamespace, readCrateTables, type ResetApi } from './reset-ownership';
import { createObjectOwnershipCheck, inspectBucketObjects, clearBucketObjects } from './reset-objects';

export async function resetCrateServer(input: {
	api: ResetApi;
	accountId: string;
	metadata: CloudflareDeploymentMetadata;
	version: string;
	deleteOnly?: true;
	beforeDelete: () => Promise<void>;
	persist: () => Promise<void>;
	onProgress?: (message: string) => void;
}): Promise<void> {
	const { api, accountId, metadata } = input;
	input.onProgress?.('Checking server identity and saved reset progress…');
	const name = `crate-${metadata.deploymentId}`;
	const databaseId = metadata.d1DatabaseId;
	if (!/^[a-f0-9]{32}$/.test(accountId) || accountId !== metadata.accountId
		|| !/^[a-f0-9]{16}$/.test(metadata.deploymentId)
		|| metadata.workerName !== name || metadata.d1DatabaseName !== name || metadata.r2BucketName !== name
		|| !databaseId || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(databaseId)) {
		throw new Error('Reset blocked: this vault has no verified Crate server identity.');
	}
	// Never repeat destructive work after the old resources have been removed.
	if (metadata.reset?.phase === 'rebuilding') {
		const current = await api.getWorkerSettings(accountId, name);
		const ownStub = current.annotations?.['workers/message'] === `Crate reset ${metadata.reset.id}`;
		assertWorkerTarget(current, ownStub ? { ...metadata, d1DatabaseId: metadata.reset.databaseId } : metadata, ownStub);
		if (!ownStub) assertDeploymentIsNotDowngrade(deployedArtifact(current).version, input.version);
		if (await api.getD1Database(accountId, metadata.reset.databaseId)) {
			throw new Error('Reset blocked: the old database still exists.');
		}
		const bucket = await api.getR2Bucket(accountId, name);
		if (bucket?.creation_date === metadata.reset.bucketCreatedAt) throw new Error('Reset blocked: the old bucket still exists.');
		return;
	}
	const worker = await api.getWorkerSettings(accountId, name);
	const retired = Boolean(metadata.reset && worker.annotations?.['workers/message'] === `Crate reset ${metadata.reset.id}`);
	assertWorkerTarget(worker, metadata, retired);
	if (!retired) assertDeploymentIsNotDowngrade(deployedArtifact(worker).version, input.version);
	const namespaceId = retired ? metadata.reset!.namespaceId
		: worker.bindings!.find(binding => binding.type === 'durable_object_namespace')!.namespace_id!;
	if (metadata.reset && (metadata.reset.databaseId !== databaseId || metadata.reset.namespaceId !== namespaceId)) {
		throw new Error('Reset blocked: the saved reset target changed.');
	}
	input.onProgress?.('Checking reminder storage ownership…');
	await assertOwnedNamespace(api, accountId, name, namespaceId, retired);
	input.onProgress?.('Checking that other Workers do not share this server’s resources…');
	await assertUnsharedResources(api, metadata, namespaceId);
	const database = await api.getD1Database(accountId, databaseId);
	const bucket = await api.getR2Bucket(accountId, name);
	if (database && (database.uuid !== databaseId || database.name !== name)) {
		throw new Error('Reset blocked: the database identity changed.');
	}
	if (bucket && (bucket.name !== name || !bucket.creation_date
		|| (metadata.reset && bucket.creation_date !== metadata.reset.bucketCreatedAt))) {
		throw new Error('Reset blocked: the bucket identity changed or could not be verified.');
	}
	if ((!database || !bucket) && !retired) throw new Error('Reset blocked: a server resource is missing.');
	if (!database && bucket) throw new Error('Reset blocked: the database needed to verify bucket objects is missing.');
	input.onProgress?.('Checking the database and remote file references…');
	const check = database ? await createObjectOwnershipCheck(api, accountId, databaseId, await readCrateTables(api, accountId, databaseId)) : null;
	if (bucket && check) await inspectBucketObjects(api, accountId, name, check, input.onProgress);

	input.onProgress?.('Stopping sync on this device before removing remote data…');
	await input.beforeDelete();
	if (!metadata.reset) {
		metadata.reset = { id: randomHex(16), phase: 'clearing', databaseId, bucketCreatedAt: bucket!.creation_date!, namespaceId, ...(input.deleteOnly ? { deleteOnly: true as const } : {}) };
		await input.persist();
	}
	const checkpoint = metadata.reset;
	const latestWorker = await api.getWorkerSettings(accountId, name);
	assertWorkerTarget(latestWorker, metadata, retired);
	if (!retired && latestWorker.bindings?.find(binding => binding.type === 'durable_object_namespace')?.namespace_id !== namespaceId) {
		throw new Error('Reset blocked: the reminder namespace changed during verification.');
	}
	if (!retired) {
		// Cloudflare refuses the deleted-class export if another Worker binds the
		// namespace. The stub has no DO class and cannot serve or mutate vault data.
		input.onProgress?.('Taking the server offline and removing reminder alarms…');
		await api.retireCrateWorker(accountId, name, checkpoint.id, databaseId, name);
	}
	const verifyTarget = async () => {
		const current = await api.getWorkerSettings(accountId, name);
		if (current.annotations?.['workers/message'] !== `Crate reset ${checkpoint.id}`) {
			throw new Error('Reset paused: the Worker changed during reset.');
		}
		assertWorkerTarget(current, metadata, true);
		const currentBucket = await api.getR2Bucket(accountId, name);
		if (currentBucket && (currentBucket.name !== name || currentBucket.creation_date !== checkpoint.bucketCreatedAt)) {
			throw new Error('Reset paused: the bucket changed during reset.');
		}
	};
	await verifyTarget();
	await assertOwnedNamespace(api, accountId, name, namespaceId, true);
	input.onProgress?.('Checking that other Workers do not share this server’s resources…');
	await assertUnsharedResources(api, metadata, namespaceId);
	if (bucket && check) {
		await clearBucketObjects(api, accountId, name, check, verifyTarget, input.onProgress);
		input.onProgress?.('Removing the empty file bucket…');
		await api.deleteR2Bucket(accountId, name);
	}
	await verifyTarget();
	input.onProgress?.('Removing the old database…');
	if (database) await api.deleteD1Database(accountId, databaseId);
	metadata.reset = { ...checkpoint, phase: 'rebuilding' };
	await input.persist();
}

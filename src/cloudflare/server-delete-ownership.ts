import { CloudflareApiError, type CloudflareApiClient, type CloudflareWorkerSettings } from './cloudflare-api';
import type { CloudflareDeploymentMetadata } from './deployment-types';

export type DeleteApi = Pick<CloudflareApiClient,
	'getWorkerSettings' | 'listWorkers' | 'listDurableObjectNamespaces' | 'deleteWorker'
	| 'getD1Database' | 'queryD1' | 'deleteD1Database' | 'getR2Bucket' | 'listR2Objects' | 'deleteR2Objects' | 'deleteR2Bucket'
	| 'uploadServerDeletionWorker' | 'getWorkersSubdomain' | 'enableWorkerSubdomain' | 'verifyResetWorker'>;

export function assertDeletionIdentity(accountId: string, metadata: CloudflareDeploymentMetadata): asserts metadata is CloudflareDeploymentMetadata & { d1DatabaseId: string } {
	const name = `crate-${metadata.deploymentId}`;
	if (accountId !== metadata.accountId || !/^[a-f0-9]{32}$/.test(accountId)
		|| !/^[a-f0-9]{16}$/.test(metadata.deploymentId) || metadata.workerName !== name
		|| metadata.d1DatabaseName !== name || metadata.r2BucketName !== name
		|| !metadata.d1DatabaseId || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(metadata.d1DatabaseId)) {
		throw new Error('Deletion blocked: the selected server identity is invalid.');
	}
	const job = metadata.deletion;
	if (job && (!/^[a-f0-9]{32}$/.test(job.id) || job.databaseId !== metadata.d1DatabaseId
		|| job.helperName !== `crate-delete-${job.id}`
		|| !['removing-worker', 'clearing-bucket', 'removing-database', 'removing-helper', 'complete'].includes(job.phase))) {
		throw new Error('Deletion blocked: the saved deletion target changed.');
	}
}

export async function deletionWorkerSettings(api: DeleteApi, accountId: string, name: string): Promise<CloudflareWorkerSettings | null> {
	try { return await api.getWorkerSettings(accountId, name); }
	catch (error) {
		if (error instanceof CloudflareApiError && error.status === 404) return null;
		throw error;
	}
}

/** Only the helper with our persisted identity and exact bucket capability may be reused. */
export function assertDeletionHelper(settings: CloudflareWorkerSettings, metadata: CloudflareDeploymentMetadata, tokenHash?: string): void {
	const job = metadata.deletion!;
	const bindings = settings.bindings;
	if (settings.annotations?.['workers/message'] !== `Crate deletion ${job.id}` || !Array.isArray(bindings)
		|| bindings.length !== 4 || new Set(bindings.map(binding => binding.name)).size !== 4
		|| !bindings.some(binding => binding.type === 'r2_bucket' && binding.name === 'BUCKET' && binding.bucket_name === metadata.r2BucketName)
		|| !bindings.some(binding => binding.type === 'plain_text' && binding.name === 'CRATE_RESET_ID' && binding.text === job.id)
		|| !bindings.some(binding => binding.type === 'plain_text' && binding.name === 'CRATE_DELETE_UPLOAD_TAG'
			&& /^crate-[a-f0-9-]{36}$/.test(binding.text ?? '') && binding.text === settings.annotations?.['workers/tag'])
		|| !bindings.some(binding => binding.type === 'plain_text' && binding.name === 'CRATE_DELETE_TOKEN_HASH'
			&& /^[a-f0-9]{64}$/.test(binding.text ?? '') && (!tokenHash || binding.text === tokenHash))) {
		throw new Error('Deletion paused: the temporary cleanup Worker changed.');
	}
}

/** Resource identity, not application releases, defines what the user is deleting. */
export async function inspectDeletionResources(api: DeleteApi, metadata: CloudflareDeploymentMetadata) {
	const accountId = metadata.accountId!;
	const workers = await api.listWorkers(accountId);
	if (!Array.isArray(workers) || workers.some(worker => !worker.id) || new Set(workers.map(worker => worker.id)).size !== workers.length) {
		throw new Error('Deletion blocked: could not verify the account’s Worker list.');
	}
	const original = workers.find(worker => worker.id === metadata.workerName);
	const worker = await deletionWorkerSettings(api, accountId, metadata.workerName);
	if (Boolean(original) !== Boolean(worker) || original && !original.created_on) {
		throw new Error('Deletion paused: could not verify the Worker identity. Retry the deletion.');
	}
	if (worker) {
		if (!Array.isArray(worker.bindings)) throw new Error('Deletion blocked: could not verify the selected Worker’s bindings.');
		// Binding names, plain-text configuration, and Durable Object classes can
		// change between releases. Only storage resource identities matter here.
		for (const type of ['d1', 'r2_bucket']) {
			const bindings = worker.bindings.filter(binding => binding.type === type);
			if (bindings.length && !bindings.some(binding => type === 'd1'
				? binding.id === metadata.d1DatabaseId : binding.bucket_name === metadata.r2BucketName)) {
				throw new Error('Deletion blocked: the live Worker uses different server storage.');
			}
		}
	}
	const database = await api.getD1Database(accountId, metadata.d1DatabaseId!);
	if (database && (database.uuid !== metadata.d1DatabaseId || database.name !== metadata.d1DatabaseName)) {
		throw new Error('Deletion blocked: the database identity changed.');
	}
	const bucket = await api.getR2Bucket(accountId, metadata.r2BucketName);
	if (bucket && (bucket.name !== metadata.r2BucketName || !bucket.creation_date)) throw new Error('Deletion blocked: could not verify the file bucket identity.');
	const job = metadata.deletion;
	if (job) {
		if (original && (job.phase !== 'removing-worker' || original.created_on !== job.workerCreatedAt)) {
			throw new Error('Deletion paused: the Worker was recreated during deletion.');
		}
		if (bucket && bucket.creation_date !== job.bucketCreatedAt) throw new Error('Deletion paused: the file bucket was recreated during deletion.');
		if (database && ['removing-helper', 'complete'].includes(job.phase)) throw new Error('Deletion paused: server storage still exists.');
	} else if (bucket && metadata.reset && (metadata.reset.deleteOnly || metadata.reset.phase === 'clearing')
		&& bucket.creation_date !== metadata.reset.bucketCreatedAt) {
		throw new Error('Deletion blocked: the file bucket changed since the interrupted operation.');
	}
	const namespaces = await api.listDurableObjectNamespaces(accountId);
	if (namespaces.some(namespace => !namespace.id || !namespace.script)) throw new Error('Deletion blocked: could not verify Durable Object ownership.');
	const owned = namespaces.filter(namespace => namespace.script === metadata.workerName);
	for (const script of workers) {
		if (script.id === metadata.workerName) continue;
		const settings = await api.getWorkerSettings(accountId, script.id!);
		if (script.id === job?.helperName) {
			assertDeletionHelper(settings, metadata);
			continue;
		}
		if (!Array.isArray(settings.bindings)) throw new Error('Deletion blocked: could not inspect another Worker’s bindings.');
		if (settings.bindings.some(binding => (binding.type === 'd1' && binding.id === metadata.d1DatabaseId)
			|| (binding.type === 'r2_bucket' && binding.bucket_name === metadata.r2BucketName)
			|| (binding.type === 'durable_object_namespace' && (binding.script_name === metadata.workerName || owned.some(namespace => namespace.id === binding.namespace_id)))
			|| (binding.type === 'service' && binding.service === metadata.workerName))) {
			throw new Error('Deletion blocked: another Worker shares this server’s resources.');
		}
	}
	return { worker, database, bucket, workerCreatedAt: original?.created_on ?? null, namespaces: owned };
}

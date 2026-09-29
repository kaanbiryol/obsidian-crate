import { CloudflareApiError } from './cloudflare-api';
import { sha256Hex } from './deployment-artifacts';
import { randomHex } from './pkce';
import { DeploymentRecoveryRequiredError, withDeploymentFence, type DeploymentFence } from './deployment-fence';
import type { CloudflareDeploymentMetadata } from './deployment-types';
import { clearBucketObjects } from './reset-objects';
import { inspectTerminalDeletionFence } from './server-delete-fence';
import { assertDeletionHelper, assertDeletionIdentity, deletionWorkerSettings, inspectDeletionResources, type DeleteApi } from './server-delete-ownership';

/** Terminal deletion never migrates application data or rebuilds the selected server. */
export async function deleteCrateServer(input: {
	api: DeleteApi; accountId: string; metadata: CloudflareDeploymentMetadata;
	beforeDelete: () => Promise<void>; persist: () => Promise<void>; onProgress?: (message: string) => void;
}): Promise<void> {
	const { api, accountId, metadata, onProgress } = input;
	assertDeletionIdentity(accountId, metadata);
	onProgress?.('Checking the selected Cloudflare resources…');
	const initial = await inspectDeletionResources(api, metadata);
	if (!metadata.deletion) {
		const id = metadata.reset?.deleteOnly ? metadata.reset.id : randomHex(16);
		metadata.deletion = { id, phase: 'removing-worker', databaseId: metadata.d1DatabaseId,
			bucketCreatedAt: initial.bucket?.creation_date ?? null, workerCreatedAt: initial.workerCreatedAt, helperName: `crate-delete-${id}` };
		await input.persist();
	}
	const job = metadata.deletion;
	if (job.helperUploadPending) {
		const helper = await deletionWorkerSettings(api, accountId, job.helperName);
		if (!helper || helper.annotations?.['workers/tag'] !== job.helperUploadPending) {
			throw new DeploymentRecoveryRequiredError('The cleanup Worker upload has an uncertain outcome. Wait for its recorded upload to finish before resuming deletion.');
		}
		assertDeletionHelper(helper, metadata);
		delete job.helperUploadPending;
		await input.persist();
	}
	const cleanupToken = randomHex(32), tokenHash = await sha256Hex(cleanupToken);
	const phase = async (next: typeof job.phase) => { job.phase = next; await input.persist(); };
	const removeIfPresent = async (operation: () => Promise<void>) => {
		try { await operation(); }
		catch (error) { if (!(error instanceof CloudflareApiError && error.status === 404)) throw error; }
	};
	const removeResources = async (fence?: DeploymentFence) => {
		const mutate = async (step: string, operation: () => Promise<void>, batchHash?: string) => {
			if (fence) await fence.mutate(operation, step, batchHash);
			else await operation();
		};
		onProgress?.('Stopping sync on this device…');
		await input.beforeDelete();
		let current = await inspectDeletionResources(api, metadata);
		if (job.phase === 'removing-helper' || job.phase === 'complete') return;
		if (current.worker) {
			onProgress?.('Removing the server, web app, and reminder storage…');
			// Normal provider deletion removes this script's namespaces regardless
			// of class names. Do not force removal of resources used by other Workers.
			await mutate('delete-worker', () => removeIfPresent(() => api.deleteWorker(accountId, metadata.workerName)));
		}
		current = await inspectDeletionResources(api, metadata);
		if (current.worker || current.namespaces.length) throw new Error('Deletion paused: Cloudflare is still removing the Worker or its Durable Objects. Retry deletion.');
		if (job.phase === 'removing-worker') await phase('clearing-bucket');
		if (current.bucket) {
			const existingHelper = await deletionWorkerSettings(api, accountId, job.helperName);
			if (existingHelper) assertDeletionHelper(existingHelper, metadata);
			onProgress?.('Preparing remote file deletion…');
			let uploadTag = '';
			const publish = (tag: string) => {
				uploadTag = tag;
				return api.uploadServerDeletionWorker(accountId, job.helperName, job.id, metadata.r2BucketName, tokenHash, tag);
			};
			if (fence) await fence.uploadWorker(publish);
			else {
				const tag = `crate-${crypto.randomUUID()}`;
				job.helperUploadPending = tag;
				try { await input.persist(); }
				catch (error) { delete job.helperUploadPending; throw error; }
				try { await publish(tag); }
				catch (error) {
					if (error instanceof CloudflareApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
						delete job.helperUploadPending;
						await input.persist();
					}
					throw error;
				}
				delete job.helperUploadPending;
				await input.persist();
			}
			const helper = await deletionWorkerSettings(api, accountId, job.helperName);
			if (!helper) throw new Error('Deletion paused: the cleanup Worker is not ready. Retry deletion.');
			assertDeletionHelper(helper, metadata, tokenHash);
			if (helper.annotations?.['workers/tag'] !== uploadTag) throw new Error('Deletion paused: the cleanup Worker upload could not be verified.');
			const subdomain = await api.getWorkersSubdomain(accountId);
			if (!subdomain || !/^[a-z0-9-]+$/.test(subdomain)) throw new Error('Deletion paused: the cleanup Worker address is unavailable.');
			await mutate('enable-deletion-address', () => api.enableWorkerSubdomain(accountId, job.helperName));
			const origin = `https://${job.helperName}.${subdomain}.workers.dev`;
			await api.verifyResetWorker(origin, job.id, true, uploadTag);
			const verify = async () => {
				const resources = await inspectDeletionResources(api, metadata);
				if (resources.worker || resources.namespaces.length) throw new Error('Deletion paused: the original server was recreated.');
				if (!resources.bucket) throw new Error('The file bucket was removed. Resume deletion to finish removing the remaining resources.');
				const settings = await deletionWorkerSettings(api, accountId, job.helperName);
				if (!settings) throw new Error('Deletion paused: the cleanup Worker was removed.');
				assertDeletionHelper(settings, metadata, tokenHash);
				if (settings.annotations?.['workers/tag'] !== uploadTag) throw new Error('Deletion paused: the cleanup Worker changed during deletion.');
			};
			// The entire selected bucket is authorized for deletion. Never consult
			// application tables or interpret object keys as paths or file formats.
			await clearBucketObjects(api, accountId, metadata.r2BucketName, async () => {}, verify,
				async keys => mutate('deleteR2Objects', () => api.deleteR2Objects(origin, job.id, cleanupToken, keys), await sha256Hex(JSON.stringify(keys))),
				0, onProgress);
			await verify();
			onProgress?.('Removing the empty file bucket…');
			await mutate('deleteR2Bucket', () => removeIfPresent(() => api.deleteR2Bucket(accountId, metadata.r2BucketName)));
		}
		current = await inspectDeletionResources(api, metadata);
		if (current.bucket) throw new Error('Deletion paused: the file bucket still exists. Retry deletion.');
		await phase('removing-database');
		if (current.database) {
			onProgress?.('Removing the database and all its data…');
			await mutate('deleteD1Database', async () => {
				await removeIfPresent(() => api.deleteD1Database(accountId, job.databaseId));
				fence?.removedDatabase();
			});
		} else fence?.removedDatabase();
		if ((await inspectDeletionResources(api, metadata)).database) throw new Error('Deletion paused: the database still exists. Retry deletion.');
		await phase('removing-helper');
	};
	if (initial.database) {
		const recoverDeletionValue = await inspectTerminalDeletionFence(api, metadata);
		await withDeploymentFence({ api, accountId, databaseId: job.databaseId, recoverDeletionValue,
			record: { worker: metadata.workerName, kind: 'delete', version: '', deletionPending: true, resetId: job.id, cleanupTokenHash: tokenHash },
		}, removeResources);
	} else await removeResources();
	// No application storage or fence remains. Finish only our identified helper;
	// a lost response can safely be retried without recreating any server resource.
	const remaining = await inspectDeletionResources(api, metadata);
	if (remaining.worker || remaining.bucket || remaining.database || remaining.namespaces.length) throw new Error('Deletion paused: selected server resources still exist.');
	const helper = await deletionWorkerSettings(api, accountId, job.helperName);
	if (helper) {
		assertDeletionHelper(helper, metadata);
		onProgress?.('Removing the temporary cleanup Worker…');
		await removeIfPresent(() => api.deleteWorker(accountId, job.helperName));
	}
	if (await deletionWorkerSettings(api, accountId, job.helperName)) throw new Error('Deletion paused: the cleanup Worker still exists. Retry deletion.');
	await phase('complete');
}

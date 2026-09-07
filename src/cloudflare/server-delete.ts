import { resetCrateServer } from './server-reset';
import { assertOwnedNamespace, assertUnsharedResources, assertWorkerTarget } from './reset-ownership';
import type { CloudflareApiClient } from './cloudflare-api';

type DeleteInput = Parameters<typeof resetCrateServer>[0] & {
    api: Parameters<typeof resetCrateServer>[0]['api'] & Pick<CloudflareApiClient, 'deleteWorker'>;
};

/** Reuse verified data removal, then remove only our checkpointed retirement Worker. */
export async function deleteCrateServer(input: DeleteInput): Promise<void> {
    const { api, metadata, accountId } = input;
    if (metadata.reset && !metadata.reset.deleteOnly) throw new Error('Finish the server reset before deleting this server.');
    if (metadata.reset?.phase !== 'rebuilding') {
        await resetCrateServer({ ...input, deleteOnly: true });
    }
    const checkpoint = metadata.reset;
    if (!checkpoint?.deleteOnly || accountId !== metadata.accountId
        || !/^[a-f0-9]{32}$/.test(accountId) || !/^[a-f0-9]{16}$/.test(metadata.deploymentId)
        || metadata.workerName !== `crate-${metadata.deploymentId}`
        || metadata.d1DatabaseName !== metadata.workerName || metadata.r2BucketName !== metadata.workerName
        || metadata.d1DatabaseId !== checkpoint.databaseId) {
        throw new Error('Deletion blocked: the saved server identity changed.');
    }
    // A retry after a lost DELETE response must never rebuild or delete a replacement.
    if (await api.getD1Database(accountId, checkpoint.databaseId)
        || await api.getR2Bucket(accountId, metadata.r2BucketName)) {
        throw new Error('Deletion blocked: server storage still exists or has been recreated.');
    }
    await assertOwnedNamespace(api, accountId, metadata.workerName, checkpoint.namespaceId, true);
    const workers = await api.listWorkers(accountId);
    if (workers.some(worker => !worker.id)) throw new Error('Deletion blocked: could not verify the Worker list.');
    if (!workers.some(worker => worker.id === metadata.workerName)) return;
    await assertUnsharedResources(api, metadata, checkpoint.namespaceId);
    const worker = await api.getWorkerSettings(accountId, metadata.workerName);
    assertWorkerTarget(worker, metadata, true);
    if (worker.annotations?.['workers/message'] !== `Crate reset ${checkpoint.id}`) {
        throw new Error('Deletion blocked: the Worker changed during deletion.');
    }
    input.onProgress?.('Removing the Worker and web app…');
    await api.deleteWorker(accountId, metadata.workerName);
}

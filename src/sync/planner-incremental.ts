import { recordSyncError } from './issues';
import { BATCH_UPLOAD_CONCURRENCY } from './engine-constants';
import { pipelineUploadChunks } from './transfer-budget';
import { isAbortError } from "./abort";
import type { IncrementalSyncPlannerContext } from "./planner-types";
import { createEmptySyncResult, finalizeSyncResult, hasUnresolvedConflict, recordResolvedRace } from "./sync-result";
import { createLogger, errorMessage } from "../plugin/logger";
import type { FileEntry } from '../protocol/sync-types';
import type { SyncResult } from './types';
import { applyIncrementalLocalDeletes } from './incremental-local-deletes';
import { reconcileIncrementalRemoteChanges } from './incremental-remote-reconciliation';
import { createPathRecord } from '../protocol/path-record';
import { readIncrementalChangelog } from './incremental-changelog';

const logger = createLogger("SyncPlanner");

export async function runIncrementalSync(
  context: IncrementalSyncPlannerContext,
  options: {
    uploadConcurrency: number;
    progressCallback?: (current: number, total: number) => void;
  },
): Promise<SyncResult | null> {
  if (context.settings.lastSeq <= 0) {
    return null;
  }

  try {
    context.reportWork?.('server');
    const changelog = await readIncrementalChangelog(context.api, context.settings.lastSeq, () => context.throwIfDestroyed());
    if (!changelog) {
      logger.warn("Changelog cursor expired - pruned entries detected, falling back to full sync");
      return null;
    }
    const { changesByPath, changeCount, latestSeq } = changelog;

    logger.info(`Incremental sync: ${changeCount} remote changes since seq ${context.settings.lastSeq}`);

    context.reportWork?.('scanning');
    const unchangedPaths: string[] = [];
    const localChanges = await context.getLocalChanges(path => unchangedPaths.push(path));
    const localDeletes = await context.getLocalDeletes();
    logger.info(`Incremental sync: ${localChanges.length} local changes detected`);
    logger.info(`Incremental sync: ${localDeletes.length} local deletes detected`);

    const result = createEmptySyncResult();
    result.settledPaths.push(...unchangedPaths.filter(path => !changesByPath.has(path)));

    if (changeCount === 0 && localChanges.length === 0 && localDeletes.length === 0) {
      if (unchangedPaths.length > 0) await context.localManifest.save();
      context.settings.lastSeq = latestSeq;
      return result;
    }


    const {
      discoveredLocalChanges,
      resurrectPaths,
      restoreDeletedPaths,
      remoteUnchangedLocalDeletes,
      reclassifiedPaths,
      downloadRequests,
      conflicts,
    } = await reconcileIncrementalRemoteChanges(context, changesByPath, localChanges, localDeletes, result);

    const localOnlyChanges = [...localChanges, ...discoveredLocalChanges].filter(
      (file) =>
        (!changesByPath.has(file.path) || resurrectPaths.has(file.path) || reclassifiedPaths.has(file.path))
        && !context.shouldIgnore(file.path),
    );
    const localOnlyDeletes = localDeletes.filter(
      (path) => (!changesByPath.has(path) || remoteUnchangedLocalDeletes.has(path))
        && !context.shouldIgnore(path),
    );
    const total = changesByPath.size + localOnlyChanges.length + localOnlyDeletes.length;
    let current = 0;
    options.progressCallback?.(current, total);

    if (downloadRequests.length > 0) {
      let downloadsProcessed = 0;
      context.reportWork?.('downloading', downloadsProcessed, downloadRequests.length);
      await context.parallelDownloadAndSaveFiles(downloadRequests, result, () => {
        downloadsProcessed++;
        current++;
        context.reportWork?.('downloading', downloadsProcessed, downloadRequests.length);
        options.progressCallback?.(current, total);
      });
      for (const path of restoreDeletedPaths) {
        if (result.downloadedPaths.includes(path) && !hasUnresolvedConflict(result, path)) {
          recordResolvedRace(result, path, "kept-remote-edit");
        }
      }
    }

    for (const diff of conflicts) {
      try {
        const localFiles = createPathRecord<FileEntry>();
        context.reportWork?.('applying');
        const outcome = await context.processDiff(diff, localFiles, result);
        if (outcome.status === "deferred") {
          recordSyncError(result, `${outcome.reason}`, diff.path);
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        recordSyncError(result, `${errorMessage(error)}`, diff.path);
      }
    }

    current = changesByPath.size;
    options.progressCallback?.(current, total);

    if (localOnlyChanges.length) context.reportWork?.('preparing');
    const preparedChunks = pipelineUploadChunks(localOnlyChanges, async (file) => {
      context.throwIfDestroyed();
      try {
        const uploadFile = await context.prepareUploadFromPath(file.path);
        if (uploadFile) {
          if (resurrectPaths.has(file.path)) {
            uploadFile.expectedHash = null;
          }
          return uploadFile;
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        recordSyncError(result, `${errorMessage(error)}`, file.path);
      }
      current++;
      options.progressCallback?.(current, total);
      return null;
    });

    let uploadsProcessed = 0;
    for await (const chunk of preparedChunks) {
      context.throwIfDestroyed();
      let reported = 0;
      context.reportWork?.('uploading', uploadsProcessed, localOnlyChanges.length);
      await context.uploadPreparedFiles(chunk, result, {
        onProcessed: (count) => {
          reported += count;
          uploadsProcessed += count;
          context.reportWork?.('uploading', uploadsProcessed, localOnlyChanges.length);
          current += count;
          options.progressCallback?.(current, total);
        },
        concurrency: options.uploadConcurrency,
        batchConcurrency: BATCH_UPLOAD_CONCURRENCY,
        retry: true,
        ...(context.reconcileVersionConflicts ? {
          onVersionConflicts: (paths: string[], syncResult: SyncResult) =>
            context.reconcileVersionConflicts!(paths, syncResult),
        } : {}),
      });
      uploadsProcessed += chunk.length - reported;
      context.reportWork?.('uploading', uploadsProcessed, localOnlyChanges.length);
      current += chunk.length - reported;
      options.progressCallback?.(current, total);
    }
    for (const path of resurrectPaths) {
      if (result.uploadedPaths.includes(path)) {
        recordResolvedRace(result, path, "kept-local-edit");
      }
    }

    if (localOnlyDeletes.length > 0) {
      context.reportWork?.('applying');
      await applyIncrementalLocalDeletes(context, localOnlyDeletes, result);

      current += localOnlyDeletes.length;
      options.progressCallback?.(current, total);
    }

    context.reportWork?.('saving');
    await context.localManifest.save();
    if (finalizeSyncResult(result)) {
      context.settings.lastSeq = latestSeq;
    }

    logger.info(
      `Incremental sync completed: ${result.uploaded} up, ${result.downloaded} down, ${result.merged} merged, ${result.deleted} del, ${result.conflicts.length} conflicts`,
    );
    return result;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    logger.warn("Incremental sync failed, falling back to full sync:", errorMessage(error));
    return null;
  }
}

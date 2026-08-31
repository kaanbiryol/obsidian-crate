import { isAbortError } from "./abort";
import type { IncrementalSyncPlannerContext } from "./planner-types";
import { createEmptySyncResult, finalizeSyncResult, hasUnresolvedConflict, recordResolvedRace } from "./sync-result";
import { createLogger, errorMessage } from "../plugin/logger";
import type { ChangelogEntry, FileEntry, MutationFailure, PreparedUpload, SyncResult } from "../plugin/types";
import { deleteFilesInBatches } from './delete-batches';
import { planIncrementalRemoteChanges } from './planner-incremental-remote-plan';

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
    const allChanges: ChangelogEntry[] = [];
    let since = context.settings.lastSeq;
    let latestSeq = since;

    while (true) {
      const response = await context.api.getChanges(since);

      if (response.cursorExpired) {
        logger.warn("Changelog cursor expired - pruned entries detected, falling back to full sync");
        return null;
      }

      allChanges.push(...response.changes);
      latestSeq = response.lastSeq;

      if (!response.hasMore || response.changes.length === 0) {
        break;
      }

      const lastChange = response.changes[response.changes.length - 1];
      if (!lastChange) {
        break;
      }

      since = lastChange.seq;
    }

    logger.info(`Incremental sync: ${allChanges.length} remote changes since seq ${context.settings.lastSeq}`);

    const localChanges = await context.getLocalChanges();
    const localDeletes = await context.getLocalDeletes();
    logger.info(`Incremental sync: ${localChanges.length} local changes detected`);
    logger.info(`Incremental sync: ${localDeletes.length} local deletes detected`);

    if (allChanges.length === 0 && localChanges.length === 0 && localDeletes.length === 0) {
      context.settings.lastSeq = latestSeq;
      return createEmptySyncResult();
    }

    const changesByPath = new Map<string, ChangelogEntry>();
    for (const entry of allChanges) {
      changesByPath.set(entry.path, entry);
    }

    const result = createEmptySyncResult();
    const {
      resurrectPaths,
      restoreDeletedPaths,
      remoteUnchangedLocalDeletes,
      reclassifiedPaths,
      downloadRequests,
      conflicts,
    } = await planIncrementalRemoteChanges(context, changesByPath, localChanges, localDeletes, result);

    const localOnlyChanges = localChanges.filter(
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

    if (downloadRequests.length > 0) {
      await context.parallelDownloadAndSaveFiles(downloadRequests, result);
      for (const path of restoreDeletedPaths) {
        if (result.downloadedPaths.includes(path) && !hasUnresolvedConflict(result, path)) {
          recordResolvedRace(result, path, "kept-remote-edit");
        }
      }
    }
    current += changesByPath.size;
    options.progressCallback?.(current, total);

    for (const diff of conflicts) {
      try {
        const localFiles: Record<string, FileEntry> = {};
        const outcome = await context.processDiff(diff, localFiles, result);
        if (outcome.status === "deferred") {
          result.errors.push(`${diff.path}: ${outcome.reason}`);
        }
      } catch (error) {
        result.errors.push(`${diff.path}: ${errorMessage(error)}`);
      }
    }

    const localOnlyUploads: PreparedUpload[] = [];
    for (const file of localOnlyChanges) {
      try {
        const uploadFile = await context.prepareUploadFromPath(file.path);
        if (uploadFile) {
          if (resurrectPaths.has(file.path)) {
            uploadFile.expectedHash = null;
          }
          localOnlyUploads.push(uploadFile);
        }
      } catch (error) {
        result.errors.push(`${file.path}: ${errorMessage(error)}`);
      }
      current++;
      options.progressCallback?.(current, total);
    }

    await context.uploadPreparedFiles(localOnlyUploads, result, {
      concurrency: options.uploadConcurrency,
      retry: true,
      ...(context.reconcileVersionConflicts ? {
        onVersionConflicts: (paths: string[], syncResult: SyncResult) =>
          context.reconcileVersionConflicts!(paths, syncResult),
      } : {}),
    });
    for (const path of resurrectPaths) {
      if (result.uploadedPaths.includes(path)) {
        recordResolvedRace(result, path, "kept-local-edit");
      }
    }

    if (localOnlyDeletes.length > 0) {
      try {
        const deleteFiles = localOnlyDeletes.flatMap((path) => {
          const expectedHash = context.localManifest.getEntry(path)?.hash;
          return expectedHash ? [{ path, expectedHash }] : [];
        });
        const missingExpectedPaths = localOnlyDeletes.filter(
          (path) => !context.localManifest.getEntry(path)?.hash,
        );
        for (const path of missingExpectedPaths) {
          result.errors.push(`${path}: Missing remote version for delete`);
        }
        const deleteResult = deleteFiles.length > 0
          ? await deleteFilesInBatches(context.api, deleteFiles)
          : { success: true, deleted: [], errors: [] };
        for (const path of deleteResult.deleted) {
          context.localManifest.removeEntry(path);
          result.deleted++;
          result.deletedPaths.push(path);
        }

        if (!deleteResult.success) {
          const deletedSet = new Set(deleteResult.deleted);
          const failures: MutationFailure[] = deleteResult.errors && deleteResult.errors.length > 0
            ? deleteResult.errors
            : localOnlyDeletes
                .filter((path) => !deletedSet.has(path))
                .map((path) => ({ path, error: "Batch delete failed" }));

          const versionConflicts = failures.filter(
            (failure) => failure.code === 'version_conflict' || failure.status === 409,
          );
          const otherFailures = failures.filter((failure) => !versionConflicts.includes(failure));
          for (const failure of otherFailures) {
            result.errors.push(`${failure.path}: ${failure.error}`);
          }
          if (versionConflicts.length > 0) {
            if (context.reconcileVersionConflicts) {
              await context.reconcileVersionConflicts(
                versionConflicts.map((failure) => `delete:${failure.path}`),
                result,
              );
            } else {
              for (const failure of versionConflicts) {
                result.errors.push(`${failure.path}: ${failure.error}`);
              }
            }
          }
        }
      } catch (error) {
        const errMsg = errorMessage(error);
        for (const path of localOnlyDeletes) {
          result.errors.push(`${path}: ${errMsg}`);
        }
      }

      current += localOnlyDeletes.length;
      options.progressCallback?.(current, total);
    }

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

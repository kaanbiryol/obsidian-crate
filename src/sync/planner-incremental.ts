import { createConflictCopy } from "./conflict";
import { computeHash } from "./hasher";
import { isHiddenPath } from "./file-discovery";
import { deleteRemotePathLocally, isVaultTFileLike } from "./planner-helpers";
import { isAbortError } from "./abort";
import type { IncrementalSyncPlannerContext } from "./planner-types";
import { createEmptySyncResult, finalizeSyncResult } from "./sync-result";
import { createLogger, errorMessage } from "../plugin/logger";
import type { ChangelogEntry, FileDiff, FileEntry, PreparedUpload, SyncResult } from "../plugin/types";
import { MAX_FILE_SIZE_BYTES } from "../plugin/types";

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
    const localChangedPaths = new Set(localChanges.map((file) => file.path));
    const localDeletedPaths = new Set(localDeletes);
    const resurrectPaths = new Set<string>();
    const reclassifiedPaths = new Set<string>();
    const downloadPaths: string[] = [];
    const conflicts: FileDiff[] = [];

    for (const [path, entry] of changesByPath) {
      if (context.shouldIgnore(path)) {
        continue;
      }

      try {
        if (entry.action === "delete") {
          if (localChangedPaths.has(path)) {
            resurrectPaths.add(path);
            result.conflicts.push(path);
            continue;
          }

          const deletedLocally = await deleteRemotePathLocally(context, path);
          context.localManifest.removeEntry(path);
          if (deletedLocally) {
            result.deleted++;
            result.deletedPaths.push(path);
          }
          continue;
        }

        if (entry.size > MAX_FILE_SIZE_BYTES) {
          result.errors.push(`${path}: Skipped remote file larger than 25MB`);
          continue;
        }

        if (localDeletedPaths.has(path)) {
          const response = await context.api.downloadFile(path);
          const conflictPath = await createConflictCopy(context.vault, path, response.content);
          result.conflicts.push(conflictPath);
          continue;
        }

        const localFile = context.vault.getAbstractFileByPath(path);
        if (!localFile && !(isHiddenPath(path) && await context.vault.adapter.exists(path))) {
          downloadPaths.push(path);
          continue;
        }

        const stat = isVaultTFileLike(localFile)
          ? localFile.stat
          : await context.vault.adapter.stat(path);
        if ((stat?.size ?? 0) > MAX_FILE_SIZE_BYTES) {
          result.errors.push(`${path}: Skipped local file larger than 25MB`);
          continue;
        }

        const content = await context.vault.adapter.readBinary(path);
        const localHash = await computeHash(content);

        if (localHash === entry.hash) {
          context.localManifest.setEntry(path, {
            hash: localHash,
            size: stat?.size ?? 0,
            modified: new Date(stat?.mtime ?? Date.now()).toISOString(),
          });
        } else if (localChangedPaths.has(path)) {
          const manifestEntry = context.localManifest.getEntry(path);
          if (manifestEntry && entry.hash === manifestEntry.hash) {
            reclassifiedPaths.add(path);
          } else {
            conflicts.push({
              path,
              action: "conflict",
              localHash,
              remoteHash: entry.hash,
            });
          }
        } else {
          downloadPaths.push(path);
        }
      } catch (error) {
        result.errors.push(`${path}: ${errorMessage(error)}`);
      }
    }

    const localOnlyChanges = localChanges.filter(
      (file) =>
        (!changesByPath.has(file.path) || resurrectPaths.has(file.path) || reclassifiedPaths.has(file.path))
        && !context.shouldIgnore(file.path),
    );
    const localOnlyDeletes = localDeletes.filter(
      (path) => !changesByPath.has(path) && !context.shouldIgnore(path),
    );
    const total = changesByPath.size + localOnlyChanges.length + localOnlyDeletes.length;
    let current = 0;

    if (downloadPaths.length > 0) {
      await context.parallelDownloadAndSaveFiles(downloadPaths, result);
    }
    current += changesByPath.size;
    options.progressCallback?.(current, total);

    for (const diff of conflicts) {
      try {
        const localFiles: Record<string, FileEntry> = {};
        await context.processDiff(diff, localFiles, result);
      } catch (error) {
        result.errors.push(`${diff.path}: ${errorMessage(error)}`);
      }
    }

    const localOnlyUploads: PreparedUpload[] = [];
    for (const file of localOnlyChanges) {
      try {
        const uploadFile = await context.prepareUploadFromPath(file.path);
        if (uploadFile) {
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
      retry: false,
    });

    if (localOnlyDeletes.length > 0) {
      try {
        const deleteResult = await context.api.batchDelete(localOnlyDeletes);
        for (const path of deleteResult.deleted) {
          context.localManifest.removeEntry(path);
          result.deleted++;
          result.deletedPaths.push(path);
        }

        if (!deleteResult.success) {
          const deletedSet = new Set(deleteResult.deleted);
          const failures = deleteResult.errors && deleteResult.errors.length > 0
            ? deleteResult.errors
            : localOnlyDeletes
                .filter((path) => !deletedSet.has(path))
                .map((path) => ({ path, error: "Batch delete failed" }));

          for (const failure of failures) {
            result.errors.push(`${failure.path}: ${failure.error}`);
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

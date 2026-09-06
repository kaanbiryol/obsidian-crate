import { computeHash } from "./hasher";
import { recordAppliedContent, UNVERIFIED_MODIFIED } from './applied-content';
import { applyRemoteContentIfUnchanged, preserveLocalVersionsAndApplyRemote } from "./local-apply";
import { isMarkdownPath } from "./markdown-base-cache";
import { mergeMarkdownContent } from "./markdown-merge";
import { deletePathLocallyIfUnchanged, isVaultTFileLike } from "./planner-helpers";
import { hasUnresolvedConflict, recordResolvedRace, recordUnresolvedConflict } from "./sync-result";
import { downloadAndSaveFile, validateDownloadedContent } from "./transfer-download";
import { prepareUploadFromPath } from "./transfer-prepare";
import type { DiffApplyOutcome, TransferContext } from "./transfer-types";
import type { ConflictDiff, FileDiff, SyncResult } from './types';
import type { FileEntry } from '../protocol/sync-types';
import { MAX_FILE_SIZE_BYTES } from '../protocol/sync-limits';

export async function processDiff(
  context: TransferContext,
  diff: FileDiff,
  localFiles: Record<string, FileEntry>,
  result: SyncResult,
): Promise<DiffApplyOutcome> {
  switch (diff.action) {
    case "upload": {
      const uploadFile = await prepareUploadFromPath(context, diff.path, {
        force: true,
        expectedHash: diff.remoteHash ?? null,
      });
      if (!uploadFile) {
        return {
          status: "deferred",
          reason: "Local file changed or disappeared while preparing the upload",
        };
      }

      const uploadResult = await context.api.uploadFile(
        uploadFile.path,
        uploadFile.content,
        uploadFile.hash,
        uploadFile.size,
        uploadFile.contentType || "application/octet-stream",
        uploadFile.expectedHash ?? null,
      );
      if (!uploadResult.success) {
        throw new Error(uploadResult.error || "Upload failed");
      }
      if (uploadResult.hash && uploadResult.hash !== uploadFile.hash) {
        throw new Error(`Hash mismatch after upload (expected ${uploadFile.hash}, got ${uploadResult.hash})`);
      }

      result.uploaded++;
      result.uploadedPaths.push(uploadFile.path);
      const modified = await context.getModifiedIso(uploadFile.path, uploadFile.mtime);
      const entry: FileEntry = {
        hash: uploadFile.hash,
        revision: uploadResult.revision,
        size: uploadFile.size,
        modified,
      };
      context.localManifest.setEntry(uploadFile.path, entry);
      if (isMarkdownPath(uploadFile.path)) {
        await context.markdownBaseCache?.putBase(uploadFile.path, uploadFile.hash, uploadFile.content);
      }
      localFiles[uploadFile.path] = entry;
      if (diff.cause === "remote-deleted") {
        recordResolvedRace(result, diff.path, "kept-local-edit");
      }
      return { status: "applied" };
    }

    case "download": {
      if (!diff.remoteHash) throw new Error("Missing remote hash for download");
      const outcome = await downloadAndSaveFile(context, {
        path: diff.path,
        expectedLocalHash: diff.localHash ?? null,
        expectedRemoteHash: diff.remoteHash,
        remoteSize: 0,
      }, result);
      if (outcome.status === "deferred") return outcome;

      const manifestEntry = context.localManifest.getEntry?.(diff.path);
      if (manifestEntry) localFiles[diff.path] = manifestEntry;
      if (diff.cause === "local-deleted" && !hasUnresolvedConflict(result, diff.path)) {
        recordResolvedRace(result, diff.path, "kept-remote-edit");
      }
      return { status: "applied" };
    }

    case "conflict": {
      const response = await context.api.downloadFile(diff.path);
      const remoteContent = response.content;
      if (remoteContent.byteLength > MAX_FILE_SIZE_BYTES) {
        throw new Error("Skipped remote file larger than 25MB");
      }
      await validateDownloadedContent(
        diff.path,
        remoteContent,
        response.size,
        response.hash,
        diff.remoteHash ?? "",
      );

      const localFile = context.vault.getAbstractFileByPath(diff.path);
      const hasLocalFile = isVaultTFileLike(localFile) || await context.vault.adapter.exists(diff.path);
      if (!hasLocalFile) {
        return {
          status: "deferred",
          reason: "Local file changed or disappeared before conflict resolution",
        };
      }

      const localContent = await context.vault.adapter.readBinary(diff.path);
      const baseHash = context.localManifest.getEntry?.(diff.path)?.hash;
      const autoMergeOutcome = await tryAutoMergeMarkdownConflict(
        context,
        diff,
        localContent,
        remoteContent,
        localFiles,
        result,
      );
      if (autoMergeOutcome) return autoMergeOutcome;

      const applyOutcome = await preserveLocalVersionsAndApplyRemote(
        context,
        diff.path,
        localContent,
        remoteContent,
        async (copy) => {
          recordUnresolvedConflict(result, diff.path, copy.path);
          await context.conflictStore?.record({
            originalPath: diff.path,
            conflictPath: copy.path,
            cause: diff.cause,
            localHash: copy.hash,
            remoteHash: diff.remoteHash,
            ...(baseHash ? { baseHash } : {}),
          });
        },
      );
      if (applyOutcome.status === "deferred") return applyOutcome;

      localFiles[diff.path] = await recordAppliedContent(context, diff.path, remoteContent, response.revision);
      return { status: "applied" };
    }

    case "delete": {
      if (!diff.remoteHash) throw new Error("Missing remote hash for delete");
      await context.api.deleteFile(diff.path, diff.remoteHash, diff.remoteRevision);
      delete localFiles[diff.path];
      context.localManifest.removeEntry(diff.path);
      result.deleted++;
      result.deletedPaths.push(diff.path);
      return { status: "applied" };
    }

    case "delete-local": {
      const localDelete = await deletePathLocallyIfUnchanged(context, diff.path, diff.localHash ?? null);
      if (localDelete.status === "changed") {
        return processDiff(context, {
          path: diff.path,
          action: "upload",
          localHash: localDelete.hash,
          cause: "remote-deleted",
        }, localFiles, result);
      }
      delete localFiles[diff.path];
      context.localManifest.removeEntry(diff.path);
      if (localDelete.status === "deleted") {
        result.deleted++;
        result.deletedPaths.push(diff.path);
      }
      return { status: "applied" };
    }
  }
}

async function tryAutoMergeMarkdownConflict(
  context: TransferContext,
  diff: ConflictDiff,
  localContent: ArrayBuffer,
  remoteContent: ArrayBuffer,
  localFiles: Record<string, FileEntry>,
  result: SyncResult,
): Promise<DiffApplyOutcome | null> {
  if (!isMarkdownPath(diff.path) || !context.markdownBaseCache) {
    return null;
  }

  const manifestHash = context.localManifest.getEntry?.(diff.path)?.hash;
  if (!manifestHash) {
    return null;
  }

  const baseContent = await context.markdownBaseCache.readBase(diff.path, manifestHash);
  if (!baseContent) {
    return null;
  }

  const mergeResult = mergeMarkdownContent(baseContent, localContent, remoteContent);
  if (!mergeResult.success) {
    return null;
  }

  const mergedContent = mergeResult.content;
  const mergedHash = await computeHash(mergedContent);
  const uploadResult = await context.api.uploadFile(
    diff.path,
    mergedContent,
    mergedHash,
    mergedContent.byteLength,
    "text/markdown",
    diff.remoteHash ?? null,
  );
  if (!uploadResult.success) {
    throw new Error(uploadResult.error || "Upload failed");
  }
  if (uploadResult.hash && uploadResult.hash !== mergedHash) {
    throw new Error(`Hash mismatch after upload (expected ${mergedHash}, got ${uploadResult.hash})`);
  }

  // The remote compare-and-swap happens first. Revalidate the local file before
  // replacing it so an edit made while the request was in flight is retained.
  const plannedLocalHash = await computeHash(localContent);
  const localApplyOutcome = await applyRemoteContentIfUnchanged(
    context,
    diff.path,
    mergedContent,
    plannedLocalHash,
  );
  if (localApplyOutcome.status === "deferred") {
    // The uploaded merge already contains this local snapshot. Keep that
    // snapshot as a virtual common ancestor so the next reconciliation can
    // merge only the newer local edits into the remote merge without
    // duplicating the local changes that were just uploaded.
    const localBaseEntry: FileEntry = {
      hash: plannedLocalHash,
      size: localContent.byteLength,
      modified: UNVERIFIED_MODIFIED,
    };
    context.localManifest.setEntry(diff.path, localBaseEntry);
    await context.markdownBaseCache.putBase(diff.path, plannedLocalHash, localContent);
    return {
      status: "deferred",
      reason: "Local file changed while applying the merged version",
    };
  }

  localFiles[diff.path] = await recordAppliedContent(context, diff.path, mergedContent, uploadResult.revision);
  result.merged++;
  result.mergedPaths.push(diff.path);
  return { status: "applied" };
}

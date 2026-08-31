import type { TFile } from "obsidian";
import { computeHash } from "./hasher";
import { createConflictCopy } from "./conflict";
import { isHiddenPath } from "./file-discovery";
import { isMarkdownPath } from "./markdown-base-cache";
import { mergeMarkdownContent } from "./markdown-merge";
import { downloadAndSaveFile, validateDownloadedContent } from "./transfer-download";
import { isVaultTFileLike, prepareUploadFromPath } from "./transfer-prepare";
import { deletePathLocallyIfUnchanged } from "./planner-helpers";
import { hasUnresolvedConflict, recordResolvedRace, recordUnresolvedConflict } from "./sync-result";
import type { TransferContext } from "./transfer-types";
import type { ConflictDiff, FileDiff, FileEntry, SyncResult } from "../plugin/types";
import { MAX_FILE_SIZE_BYTES } from "../plugin/types";

export async function processDiff(
  context: TransferContext,
  diff: FileDiff,
  localFiles: Record<string, FileEntry>,
  result: SyncResult,
): Promise<void> {
  const hidden = isHiddenPath(diff.path);

  switch (diff.action) {
    case "upload": {
      const uploadFile = await prepareUploadFromPath(context, diff.path, {
		force: true,
		expectedHash: diff.remoteHash ?? null,
	  });
      if (!uploadFile) {
        break;
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
      break;
    }

    case "download": {
		if (!diff.remoteHash) throw new Error("Missing remote hash for download");
      await downloadAndSaveFile(context, {
		path: diff.path,
		expectedLocalHash: diff.localHash ?? null,
		expectedRemoteHash: diff.remoteHash,
		remoteSize: 0,
	  }, result);
      const content = await context.vault.adapter.readBinary(diff.path);
      const hash = await computeHash(content);
      localFiles[diff.path] = {
        hash,
        size: content.byteLength,
        modified: await context.getModifiedIso(diff.path),
      };
	  if (diff.cause === "local-deleted" && !hasUnresolvedConflict(result, diff.path)) {
		recordResolvedRace(result, diff.path, "kept-remote-edit");
	  }
      break;
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
		diff.remoteHash ?? '',
	  );

      const localFile = context.vault.getAbstractFileByPath(diff.path);
      const visibleFile = isVaultTFileLike(localFile) ? localFile : null;
      const hasLocalFile = visibleFile !== null;
      const hasHiddenFile = hidden && await context.vault.adapter.exists(diff.path);

      if (hasLocalFile || hasHiddenFile) {
        const localContent = await context.vault.adapter.readBinary(diff.path);
        const autoMerged = await tryAutoMergeMarkdownConflict(
          context,
          diff,
          visibleFile,
          localContent,
          remoteContent,
          localFiles,
          result,
        );
        if (autoMerged) {
          break;
        }

        const conflictPath = await createConflictCopy(context.vault, diff.path, localContent);

        if (visibleFile) {
          await context.vault.modifyBinary(visibleFile, remoteContent);
        } else {
          await context.vault.adapter.writeBinary(diff.path, remoteContent);
        }

        recordUnresolvedConflict(result, diff.path, conflictPath);

        const hash = await computeHash(remoteContent);
        const entry: FileEntry = {
          hash,
          size: remoteContent.byteLength,
          modified: await context.getModifiedIso(diff.path),
        };
        localFiles[diff.path] = entry;
        context.localManifest.setEntry(diff.path, entry);
        if (isMarkdownPath(diff.path)) {
          await context.markdownBaseCache?.putBase(diff.path, hash, remoteContent);
        }
      }
      break;
    }

    case "delete": {
		if (!diff.remoteHash) throw new Error("Missing remote hash for delete");
		await context.api.deleteFile(diff.path, diff.remoteHash);
      delete localFiles[diff.path];
      context.localManifest.removeEntry(diff.path);
      result.deleted++;
      result.deletedPaths.push(diff.path);
      break;
    }

    case "delete-local": {
      const localDelete = await deletePathLocallyIfUnchanged(context, diff.path, diff.localHash ?? null);
      if (localDelete.status === "changed") {
        await processDiff(context, {
          path: diff.path,
          action: "upload",
          localHash: localDelete.hash,
          cause: "remote-deleted",
        }, localFiles, result);
        break;
      }
      delete localFiles[diff.path];
      context.localManifest.removeEntry(diff.path);
      if (localDelete.status === "deleted") {
        result.deleted++;
        result.deletedPaths.push(diff.path);
      }
      break;
    }
  }
}

async function tryAutoMergeMarkdownConflict(
  context: TransferContext,
  diff: ConflictDiff,
  visibleFile: TFile | null,
  localContent: ArrayBuffer,
  remoteContent: ArrayBuffer,
  localFiles: Record<string, FileEntry>,
  result: SyncResult,
): Promise<boolean> {
  if (!isMarkdownPath(diff.path) || !context.markdownBaseCache) {
    return false;
  }

  const manifestHash = context.localManifest.getEntry?.(diff.path)?.hash;
  if (!manifestHash) {
    return false;
  }

  const baseContent = await context.markdownBaseCache.readBase(diff.path, manifestHash);
  if (!baseContent) {
    return false;
  }

  const mergeResult = mergeMarkdownContent(baseContent, localContent, remoteContent);
  if (!mergeResult.success) {
    return false;
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
  const latestLocalContent = await context.vault.adapter.readBinary(diff.path);
  const latestLocalHash = await computeHash(latestLocalContent);
  const localChangedDuringMerge = latestLocalHash !== plannedLocalHash;

  if (!localChangedDuringMerge) {
    if (visibleFile) {
      await context.vault.modifyBinary(visibleFile, mergedContent);
    } else {
      await context.vault.adapter.writeBinary(diff.path, mergedContent);
    }
  }

  const entry: FileEntry = {
    hash: mergedHash,
    size: mergedContent.byteLength,
    modified: localChangedDuringMerge
      ? new Date().toISOString()
      : await context.getModifiedIso(diff.path),
  };
  localFiles[diff.path] = entry;
  context.localManifest.setEntry(diff.path, entry);
  await context.markdownBaseCache.putBase(diff.path, mergedHash, mergedContent);
  result.merged++;
  result.mergedPaths.push(diff.path);
  if (localChangedDuringMerge) {
    recordResolvedRace(result, diff.path, "kept-local-edit");
  }
  return true;
}

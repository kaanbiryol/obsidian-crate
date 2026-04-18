import { computeHash } from "./hasher";
import { createConflictCopy } from "./conflict";
import { isHiddenPath } from "./file-discovery";
import { downloadAndSaveFile } from "./transfer-download";
import { isVaultTFileLike, prepareUploadFromPath } from "./transfer-prepare";
import type { TransferContext } from "./transfer-types";
import type { FileDiff, FileEntry, SyncResult } from "../plugin/types";
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
      const uploadFile = await prepareUploadFromPath(context, diff.path, { force: true });
      if (!uploadFile) {
        break;
      }

      const uploadResult = await context.api.uploadFile(
        uploadFile.path,
        uploadFile.content,
        uploadFile.hash,
        uploadFile.size,
        uploadFile.contentType || "application/octet-stream",
      );
      if (!uploadResult.success) {
        throw new Error(uploadResult.error || "Upload failed");
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
      localFiles[uploadFile.path] = entry;
      break;
    }

    case "download": {
      await downloadAndSaveFile(context, diff.path, result);
      const content = await context.vault.adapter.readBinary(diff.path);
      const hash = await computeHash(content);
      localFiles[diff.path] = {
        hash,
        size: content.byteLength,
        modified: await context.getModifiedIso(diff.path),
      };
      break;
    }

    case "conflict": {
      const response = await context.api.downloadFile(diff.path);
      const remoteContent = response.content;
      if (remoteContent.byteLength > MAX_FILE_SIZE_BYTES) {
        throw new Error("Skipped remote file larger than 25MB");
      }

      const localFile = context.vault.getAbstractFileByPath(diff.path);
      const visibleFile = isVaultTFileLike(localFile) ? localFile : null;
      const hasLocalFile = visibleFile !== null;
      const hasHiddenFile = hidden && await context.vault.adapter.exists(diff.path);

      if (hasLocalFile || hasHiddenFile) {
        const localContent = await context.vault.adapter.readBinary(diff.path);
        const conflictPath = await createConflictCopy(context.vault, diff.path, localContent);

        if (visibleFile) {
          await context.vault.modifyBinary(visibleFile, remoteContent);
        } else {
          await context.vault.adapter.writeBinary(diff.path, remoteContent);
        }

        result.conflicts.push(conflictPath);

        const hash = await computeHash(remoteContent);
        const entry: FileEntry = {
          hash,
          size: remoteContent.byteLength,
          modified: await context.getModifiedIso(diff.path),
        };
        localFiles[diff.path] = entry;
        context.localManifest.setEntry(diff.path, entry);
      }
      break;
    }

    case "delete": {
      await context.api.deleteFile(diff.path);
      delete localFiles[diff.path];
      context.localManifest.removeEntry(diff.path);
      result.deleted++;
      result.deletedPaths.push(diff.path);
      break;
    }
  }
}

import { computeHash } from "./hasher";
import { detectConflicts } from "./conflict";
import { getAllVaultFiles } from "./file-discovery";
import type { FullSyncPlan, FullSyncPlannerContext } from "./planner-types";
import { MAX_FILE_SIZE_BYTES } from "../plugin/types";

export async function createFullSyncPlan(
  context: FullSyncPlannerContext,
  remoteFiles: Record<string, import("../plugin/types").FileEntry>,
  prepareConcurrency: number,
): Promise<FullSyncPlan> {
  const localFiles: Record<string, import("../plugin/types").FileEntry> = {};
  const files = await getAllVaultFiles(context.vault, context.shouldIgnore.bind(context));
  const largeLocalPaths = new Set(
    files.filter((file) => file.size > MAX_FILE_SIZE_BYTES).map((file) => file.path),
  );
  const eligible = files.filter((file) => file.size <= MAX_FILE_SIZE_BYTES);

  for (const file of eligible) {
    const existing = context.localManifest.getEntry(file.path);
    if (existing && existing.size === file.size) {
      const manifestMtime = new Date(existing.modified).getTime();
      if (!Number.isNaN(manifestMtime) && manifestMtime === file.mtime) {
        localFiles[file.path] = {
          hash: existing.hash,
          size: file.size,
          modified: new Date(file.mtime).toISOString(),
        };
      }
    }
  }

  const hashTasks = eligible
    .filter((file) => !(file.path in localFiles))
    .map((file) => async () => {
      const content = await context.vault.adapter.readBinary(file.path);
      const hash = await computeHash(content);
      return { path: file.path, hash, size: file.size, mtime: file.mtime };
    });
  const hashed = await context.runConcurrent(hashTasks, prepareConcurrency);
  for (const entry of hashed) {
    localFiles[entry.path] = {
      hash: entry.hash,
      size: entry.size,
      modified: new Date(entry.mtime).toISOString(),
    };
  }

  const manifestEntries = context.localManifest.getManifest().files;
  const diffMap = new Map<string, import("../plugin/types").FileDiff>();
  for (const diff of detectConflicts(localFiles, remoteFiles, manifestEntries)) {
    diffMap.set(diff.path, diff);
  }

  const localDeletes = await context.getLocalDeletes();
  for (const path of localDeletes) {
    const remoteEntry = remoteFiles[path];
    if (!remoteEntry) {
      context.localManifest.removeEntry(path);
      continue;
    }

    const manifestEntry = manifestEntries[path];
    if (manifestEntry && remoteEntry.hash === manifestEntry.hash) {
      diffMap.set(path, { path, action: "delete", remoteHash: remoteEntry.hash });
    }
  }

  const errors: string[] = [];
  for (const [path, diff] of [...diffMap.entries()]) {
    const remoteEntry = remoteFiles[path];
    if (context.shouldIgnore(path)) {
      diffMap.delete(path);
      continue;
    }
    if (largeLocalPaths.has(path)) {
      errors.push(`${path}: Skipped local file larger than 25MB`);
      diffMap.delete(path);
      continue;
    }
    if (remoteEntry && remoteEntry.size > MAX_FILE_SIZE_BYTES) {
      errors.push(`${path}: Skipped remote file larger than 25MB`);
      diffMap.delete(path);
      continue;
    }
    if (diff.action === "download" && !remoteEntry) {
      diffMap.delete(path);
    }
  }

  const diffs = [...diffMap.values()];
  return {
    localFiles,
    diffs,
    uploadDiffs: diffs.filter((diff) => diff.action === "upload"),
    downloadDiffs: diffs.filter((diff) => diff.action === "download"),
    remainingDiffs: diffs.filter((diff) => diff.action === "conflict" || diff.action === "delete"),
    errors,
  };
}

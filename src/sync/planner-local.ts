import { computeHash } from "./hasher";
import { getAllVaultFiles } from "./file-discovery";
import type { LocalDiffPlannerContext } from "./planner-types";
import { MAX_FILE_SIZE_BYTES } from '../protocol/sync-limits';

export async function getLocalDeletes(
  context: LocalDiffPlannerContext,
  prepareConcurrency: number,
): Promise<string[]> {
  const knownPaths = context.localManifest
    .getAllPaths()
    .filter((path) => !context.shouldIgnore(path));

  const tasks = knownPaths.map((path) => async () => {
    context.throwIfDestroyed?.();
    const exists = await context.vault.adapter.exists(path);
    context.throwIfDestroyed?.();
    return exists ? null : path;
  });

  const results = await context.runConcurrent(tasks, prepareConcurrency);
  context.throwIfDestroyed?.();
  return results.filter((path): path is string => path !== null);
}

export async function getLocalChanges(
  context: LocalDiffPlannerContext,
  prepareConcurrency: number,
  onUnchanged?: (path: string) => void,
): Promise<Array<{ path: string; hash: string }>> {
  const changes: Array<{ path: string; hash: string }> = [];
  const allFiles = await getAllVaultFiles(context.vault, context.shouldIgnore.bind(context), () => context.throwIfDestroyed?.());
  await context.verifyContent?.(allFiles);
  context.throwIfDestroyed?.();

  for (const file of allFiles) {
    if (file.size > MAX_FILE_SIZE_BYTES) changes.push({ path: file.path, hash: context.localManifest.getEntry(file.path)?.hash ?? "" });
  }

  const candidates = allFiles.filter((file) => {
    if (file.size > MAX_FILE_SIZE_BYTES) return false;

    if (context.pendingPaths?.has(file.path)) return true;
    const existing = context.localManifest.getEntry(file.path);
    if (!existing) return true;
    if (existing.size !== file.size) return true;

    const manifestMtime = new Date(existing.modified).getTime();
    return Number.isNaN(manifestMtime) || manifestMtime !== file.mtime;
  });

  const tasks = candidates.map((file) => async () => {
    context.throwIfDestroyed?.();
    const content = await context.vault.adapter.readBinary(file.path);
    context.throwIfDestroyed?.();
    const hash = await computeHash(content);
    context.throwIfDestroyed?.();
      context.plannedContent?.remember(file.path, content, hash);
    const existing = context.localManifest.getEntry(file.path);
    if (!existing || existing.hash !== hash) {
      return { path: file.path, hash };
    }
    context.localManifest.setEntry(file.path, {
      ...existing,
      hash,
      size: file.size,
      modified: new Date(file.mtime).toISOString(),
    });
    onUnchanged?.(file.path);
    return null;
  });

  const results = await context.runConcurrent(tasks, prepareConcurrency);
  context.throwIfDestroyed?.();
  for (const result of results) {
    if (result) {
      changes.push(result);
    }
  }

  return changes;
}

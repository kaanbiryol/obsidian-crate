import { computeHash } from "./hasher";
import { getAllVaultFiles } from "./file-discovery";
import type { LocalDiffPlannerContext } from "./planner-types";
import { MAX_FILE_SIZE_BYTES } from "../plugin/types";

export async function getLocalDeletes(
  context: LocalDiffPlannerContext,
  prepareConcurrency: number,
): Promise<string[]> {
  const knownPaths = context.localManifest
    .getAllPaths()
    .filter((path) => !context.shouldIgnore(path));

  const tasks = knownPaths.map((path) => async () => {
    const exists = await context.vault.adapter.exists(path);
    return exists ? null : path;
  });

  const results = await context.runConcurrent(tasks, prepareConcurrency);
  return results.filter((path): path is string => path !== null);
}

export async function getLocalChanges(
  context: LocalDiffPlannerContext,
  prepareConcurrency: number,
): Promise<Array<{ path: string; hash: string }>> {
  const changes: Array<{ path: string; hash: string }> = [];
  const allFiles = await getAllVaultFiles(context.vault, context.shouldIgnore.bind(context));

  const candidates = allFiles.filter((file) => {
    if (file.size > MAX_FILE_SIZE_BYTES) return false;

    const existing = context.localManifest.getEntry(file.path);
    if (!existing) return true;
    if (existing.size !== file.size) return true;

    const manifestMtime = new Date(existing.modified).getTime();
    return Number.isNaN(manifestMtime) || manifestMtime !== file.mtime;
  });

  const tasks = candidates.map((file) => async () => {
    const content = await context.vault.adapter.readBinary(file.path);
    const hash = await computeHash(content);
    const existing = context.localManifest.getEntry(file.path);
    if (!existing || existing.hash !== hash) {
      return { path: file.path, hash };
    }
    return null;
  });

  const results = await context.runConcurrent(tasks, prepareConcurrency);
  for (const result of results) {
    if (result) {
      changes.push(result);
    }
  }

  return changes;
}

import type { TAbstractFile, TFile } from "obsidian";
import { isHiddenPath } from "./file-discovery";
import type { IncrementalSyncPlannerContext } from "./planner-types";

export function isVaultTFileLike(file: TAbstractFile | null): file is TFile {
  return typeof file === "object"
    && file !== null
    && "extension" in file
    && typeof file.extension === "string"
    && "stat" in file
    && typeof file.stat === "object"
    && file.stat !== null;
}

export async function deleteRemotePathLocally(
  context: IncrementalSyncPlannerContext,
  path: string,
): Promise<boolean> {
  if (isHiddenPath(path)) {
    if (!await context.vault.adapter.exists(path)) {
      return false;
    }

    await context.vault.adapter.remove(path);
    return true;
  }

  const file = context.vault.getAbstractFileByPath(path);
  if (file) {
    if (context.fileManager) {
      await context.fileManager.trashFile(file);
    } else {
      // eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- fileManager is optional in planner-only contexts
      await context.vault.delete(file);
    }
    return true;
  }

  if (!await context.vault.adapter.exists(path)) {
    return false;
  }

  await context.vault.adapter.remove(path);
  return true;
}

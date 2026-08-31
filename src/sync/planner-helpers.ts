import type { TAbstractFile, TFile } from "obsidian";
import { isHiddenPath } from "./file-discovery";
import type { Vault } from "obsidian";
import { computeHash } from "./hasher";

export function isVaultTFileLike(file: TAbstractFile | null): file is TFile {
  return typeof file === "object"
    && file !== null
    && "extension" in file
    && typeof file.extension === "string"
    && "stat" in file
    && typeof file.stat === "object"
    && file.stat !== null;
}

interface LocalDeleteContext {
  vault: Vault;
  fileManager?: { trashFile(file: TAbstractFile): Promise<void> };
}

export type LocalDeleteOutcome =
  | { status: "deleted" }
  | { status: "missing" }
  | { status: "changed"; hash: string };

async function readLocalPathHash(context: LocalDeleteContext, path: string): Promise<string | null> {
  const visibleFile = context.vault.getAbstractFileByPath(path);
  if (!visibleFile && !await context.vault.adapter.exists(path)) {
    return null;
  }

  try {
    return await computeHash(await context.vault.adapter.readBinary(path));
  } catch (error) {
    if (!await context.vault.adapter.exists(path)) {
      return null;
    }
    throw error;
  }
}

async function deletePathLocally(
  context: LocalDeleteContext,
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

export async function deletePathLocallyIfUnchanged(
  context: LocalDeleteContext,
  path: string,
  expectedHash: string | null,
): Promise<LocalDeleteOutcome> {
  const currentHash = await readLocalPathHash(context, path);
  if (currentHash === null) {
    return { status: "missing" };
  }
  if (expectedHash === null || currentHash !== expectedHash) {
    return { status: "changed", hash: currentHash };
  }

  return await deletePathLocally(context, path)
    ? { status: "deleted" }
    : { status: "missing" };
}

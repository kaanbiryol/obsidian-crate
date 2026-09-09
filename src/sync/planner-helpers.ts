import type { Stat, TAbstractFile, TFile } from "obsidian";
import { isHiddenPath } from "./file-discovery";
import type { Vault } from "obsidian";
import { computeHash } from "./hasher";

export function isVaultTFileLike(file: TAbstractFile | null): file is TFile {
  return typeof file === "object"
    && file !== null
	&& "path" in file
	&& typeof file.path === "string"
    && "extension" in file
    && typeof file.extension === "string";
}

interface LocalDeleteContext {
  vault: Vault;
}

export type LocalDeleteOutcome =
  | { status: "deleted" }
  | { status: "missing" }
  | { status: "changed"; hash: string };

interface DeleteSnapshot {
  hash: string;
  visibleFile?: TFile;
  stat?: Stat;
}

const changedTarget = () => new Error('Local deletion target changed. Its current contents were kept; retry sync.');
const sameStat = (left: Stat, right: Stat) => left.type === right.type
  && left.ctime === right.ctime && left.mtime === right.mtime && left.size === right.size;

async function readDeleteSnapshot(context: LocalDeleteContext, path: string): Promise<DeleteSnapshot | null> {
  const visibleFile = context.vault.getAbstractFileByPath(path);
  if (visibleFile && !isVaultTFileLike(visibleFile)) throw changedTarget();
  if (!visibleFile && !await context.vault.adapter.exists(path)) {
    return null;
  }

  const stat = visibleFile && !isHiddenPath(path) ? undefined : await context.vault.adapter.stat(path);
  if ((!visibleFile || isHiddenPath(path)) && stat?.type !== 'file') throw changedTarget();

  try {
    const hash = await computeHash(await context.vault.adapter.readBinary(path));
    return { hash, ...(visibleFile && !isHiddenPath(path) ? { visibleFile } : {}), ...(stat ? { stat } : {}) };
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
  snapshot: DeleteSnapshot,
): Promise<boolean> {
  const file = context.vault.getAbstractFileByPath(path);
  if (file && !isVaultTFileLike(file)) throw changedTarget();
  if (snapshot.visibleFile) {
    if (!file && !await context.vault.adapter.exists(path)) return false;
    if (file !== snapshot.visibleFile || file.path !== path) throw changedTarget();
    // The host moves the bytes present at removal into .trash, including an
    // edit after our hash check. Never honor a permanent-delete preference for
    // remote sync: a never-uploaded edit must remain recoverable after restart.
    await context.vault.trash(file, false);
    return true;
  }

  if (!await context.vault.adapter.exists(path)) {
    return false;
  }

  const stat = await context.vault.adapter.stat(path);
  if (!snapshot.stat || !stat || stat.type !== 'file' || !sameStat(stat, snapshot.stat)) throw changedTarget();
  const current = context.vault.getAbstractFileByPath(path);
  if (current && !isVaultTFileLike(current)) throw changedTarget();
  // Adapter paths have no stable host object. Recheck their type/version as
  // late as possible; local trash still protects the final non-atomic gap.
  await context.vault.adapter.trashLocal(path);
  return true;
}

export async function deletePathLocallyIfUnchanged(
  context: LocalDeleteContext,
  path: string,
  expectedHash: string | null,
): Promise<LocalDeleteOutcome> {
  const snapshot = await readDeleteSnapshot(context, path);
  if (snapshot === null) {
    return { status: "missing" };
  }
  if (expectedHash === null || snapshot.hash !== expectedHash) {
    return { status: "changed", hash: snapshot.hash };
  }

  return await deletePathLocally(context, path, snapshot)
    ? { status: "deleted" }
    : { status: "missing" };
}

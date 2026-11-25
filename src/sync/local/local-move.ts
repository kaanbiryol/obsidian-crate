import { isVaultTFileLike } from './local-delete';
import { ensureParentFolder, isHiddenPath } from './file-discovery';
import { localPathExists } from './stored-name';
import { assertLocalSyncPath } from './local-path-safety';
import { recordAppliedContent } from '../transfer/applied-content';
import type { TransferContext } from '../transfer/types';
import { sha256Hex } from '../../platform/sha256';

/** Applies a remote rename by moving the local file instead of trashing it and downloading
 * the same bytes again. Moves only while `from` still holds `expectedHash` and nothing is at
 * `to`, and records `to` as applied like a download. An edit made during the move travels
 * with the file and is found by the next scan. Returns false when the caller must apply the
 * delete and the download instead. */
export async function moveUnchangedLocalFile(context: TransferContext, from: string, to: string, expectedHash: string, revision?: string): Promise<boolean> {
	assertLocalSyncPath(from);
	assertLocalSyncPath(to);
	const { vault } = context;
	const hidden = isHiddenPath(from);
	if (hidden !== isHiddenPath(to)) return false;
	if (vault.getAbstractFileByPath(to) || await localPathExists(vault, to)) return false;
	const file = vault.getAbstractFileByPath(from);
	if (file ? !isVaultTFileLike(file) : !hidden || (await vault.adapter.stat(from))?.type !== 'file') return false;
	const content = await vault.adapter.readBinary(from);
	if (await sha256Hex(content) !== expectedHash) return false;
	await ensureParentFolder(vault, to);
	// Vault.rename, unlike the file manager, leaves links in other notes as they are: the
	// device that renamed the file syncs its own link updates.
	if (file && !hidden) await vault.rename(file, to);
	else await vault.adapter.rename(from, to);
	await recordAppliedContent(context, to, content, revision, expectedHash);
	return true;
}

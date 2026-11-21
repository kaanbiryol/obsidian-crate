import { assertLocalSyncPath } from './local-path-safety';
import type { Vault } from 'obsidian';
import { isVaultTFileLike } from './local-delete';
import type { FileEntry } from '../../protocol/sync-types';
import { formatFileLimit } from '../../protocol/sync-limits';
import { sha256Hex } from '../../platform/sha256';
import { localPathExists } from './stored-name';

/** Read the current local metadata used by all reconciliation paths. */
export async function readLocalFileEntry(
	vault: Vault,
	path: string,
	/** The device's file limit for its server; larger files throw. */
	maxFileBytes: number,
): Promise<FileEntry | undefined> {
	assertLocalSyncPath(path);
	const abstractFile = vault.getAbstractFileByPath(path);
	const visibleFile = isVaultTFileLike(abstractFile) ? abstractFile : undefined;
	// A stored case or Unicode variant of the name is another file.
	if (!visibleFile && !await localPathExists(vault, path)) return undefined;

	const adapterStat = visibleFile ? null : await vault.adapter.stat(path);
	if (!visibleFile && adapterStat?.type !== 'file') return undefined;
	const stat = visibleFile?.stat ?? adapterStat;
	if ((stat?.size ?? 0) > maxFileBytes) {
		throw new Error(`Skipped local file larger than ${formatFileLimit(maxFileBytes)}`);
	}

	try {
		const content = await vault.adapter.readBinary(path);
		if (content.byteLength > maxFileBytes) {
			throw new Error(`Skipped local file larger than ${formatFileLimit(maxFileBytes)}`);
		}
		return {
			hash: await sha256Hex(content),
			size: content.byteLength,
			modified: new Date(stat?.mtime ?? Date.now()).toISOString(),
		};
	} catch (error) {
		if (!await vault.adapter.exists(path)) return undefined;
		throw error;
	}
}

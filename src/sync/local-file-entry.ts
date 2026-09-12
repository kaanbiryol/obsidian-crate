import { assertLocalSyncPath } from './local-path-safety';
import type { Vault } from 'obsidian';
import { computeHash } from './hasher';
import { isVaultTFileLike } from './planner-helpers';
import type { FileEntry } from '../protocol/sync-types';
import { MAX_FILE_SIZE_BYTES } from '../protocol/sync-limits';

/** Read the current local metadata used by all reconciliation paths. */
export async function readLocalFileEntry(
	vault: Vault,
	path: string,
): Promise<FileEntry | undefined> {
	assertLocalSyncPath(path);
	const abstractFile = vault.getAbstractFileByPath(path);
	const visibleFile = isVaultTFileLike(abstractFile) ? abstractFile : undefined;
	if (!visibleFile && !await vault.adapter.exists(path)) return undefined;

	const adapterStat = visibleFile ? null : await vault.adapter.stat(path);
	if (!visibleFile && adapterStat?.type !== 'file') return undefined;
	const stat = visibleFile?.stat ?? adapterStat;
	if ((stat?.size ?? 0) > MAX_FILE_SIZE_BYTES) {
		throw new Error('Skipped local file larger than 25MB');
	}

	try {
		const content = await vault.adapter.readBinary(path);
		if (content.byteLength > MAX_FILE_SIZE_BYTES) {
			throw new Error('Skipped local file larger than 25MB');
		}
		return {
			hash: await computeHash(content),
			size: content.byteLength,
			modified: new Date(stat?.mtime ?? Date.now()).toISOString(),
		};
	} catch (error) {
		if (!await vault.adapter.exists(path)) return undefined;
		throw error;
	}
}

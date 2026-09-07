import type { Vault } from 'obsidian';
import { isVaultTFileLike } from './planner-helpers';

export class LocalFilePresentError extends Error {
	constructor(path: string) {
		super(`Local file exists again; reconcile before deleting the remote file: ${path}`);
		this.name = 'LocalFilePresentError';
	}
}

/** A scan/event is only a deletion candidate. Check again at the send boundary. */
export async function assertLocalFileAbsent(vault: Vault, path: string): Promise<void> {
	if (isVaultTFileLike(vault.getAbstractFileByPath(path))) throw new LocalFilePresentError(path);
	if (!await vault.adapter.exists(path)) return;
	// Replacing a file with a folder requires deleting the old remote file.
	// A failed stat, or an existence/stat disagreement, is never proof of absence.
	if ((await vault.adapter.stat(path))?.type === 'folder') return;
	throw new LocalFilePresentError(path);
}

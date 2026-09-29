import type { TFile, Vault } from 'obsidian';

/** A retained TFile can move while a read, hash, or host write is awaiting work. */
export function isCurrentVaultFile(vault: Pick<Vault, 'getAbstractFileByPath'>, path: string, file: TFile): boolean {
	return file.path === path && vault.getAbstractFileByPath(path) === file;
}

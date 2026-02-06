/**
 * File discovery — merges Obsidian-indexed files with hidden (dot) files
 * discovered via the low-level vault adapter.
 */

import type { Vault, TFile } from 'obsidian';

/**
 * Normalised file descriptor that works for both indexed and hidden files.
 */
export interface VaultFile {
	path: string;
	size: number;
	mtime: number;
	extension: string;
}

/**
 * Check whether any segment in a path starts with a dot.
 */
export function isHiddenPath(path: string): boolean {
	return path.split('/').some(segment => segment.startsWith('.'));
}

/**
 * Extract the extension from a path string (without the leading dot).
 * Returns empty string for extensionless files like `.gitignore`.
 */
export function getExtensionFromPath(path: string): string {
	const basename = path.split('/').pop() ?? '';
	const dotIndex = basename.lastIndexOf('.');
	// No dot, or dot is the first character (e.g. `.gitignore`)
	if (dotIndex <= 0) return '';
	return basename.substring(dotIndex + 1);
}

/**
 * Convert a TFile to a VaultFile.
 */
export function tfileToVaultFile(file: TFile): VaultFile {
	return {
		path: file.path,
		size: file.stat.size,
		mtime: file.stat.mtime,
		extension: file.extension,
	};
}

/**
 * Discover all vault files — both Obsidian-indexed and hidden.
 *
 * Hidden files are discovered by recursing into dot-prefixed folders via
 * `vault.adapter.list()` + `vault.adapter.stat()`. Non-hidden folders are
 * already fully covered by `vault.getFiles()`.
 *
 * @param shouldIgnore  Predicate used to skip ignored paths early (avoids
 *                      stat-ing thousands of files in e.g. `.git/`).
 */
export async function getAllVaultFiles(
	vault: Vault,
	shouldIgnore: (path: string) => boolean,
): Promise<VaultFile[]> {
	// Start with all indexed files
	const indexedFiles = vault.getFiles();
	const result: VaultFile[] = indexedFiles
		.filter(f => !shouldIgnore(f.path))
		.map(tfileToVaultFile);

	// Collect paths already included so we don't duplicate
	const seen = new Set(result.map(f => f.path));

	// Discover hidden files by walking dot-prefixed entries at root
	const root = await vault.adapter.list('');

	// Recurse into hidden folders
	const hiddenFolders = root.folders.filter(f => {
		const name = f.split('/').pop() ?? '';
		return name.startsWith('.');
	});

	for (const folder of hiddenFolders) {
		if (shouldIgnore(folder) || shouldIgnore(folder + '/')) continue;
		await walkHiddenFolder(vault, folder, shouldIgnore, seen, result);
	}

	// Include hidden files at the root level (e.g. `.gitignore`)
	for (const filePath of root.files) {
		const name = filePath.split('/').pop() ?? '';
		if (!name.startsWith('.')) continue;
		if (seen.has(filePath) || shouldIgnore(filePath)) continue;

		const stat = await vault.adapter.stat(filePath);
		if (!stat || stat.type !== 'file') continue;

		seen.add(filePath);
		result.push({
			path: filePath,
			size: stat.size,
			mtime: stat.mtime,
			extension: getExtensionFromPath(filePath),
		});
	}

	return result;
}

/**
 * Recursively walk a hidden folder, adding files to `result`.
 */
async function walkHiddenFolder(
	vault: Vault,
	folderPath: string,
	shouldIgnore: (path: string) => boolean,
	seen: Set<string>,
	result: VaultFile[],
): Promise<void> {
	const listing = await vault.adapter.list(folderPath);

	for (const filePath of listing.files) {
		if (seen.has(filePath) || shouldIgnore(filePath)) continue;

		const stat = await vault.adapter.stat(filePath);
		if (!stat || stat.type !== 'file') continue;

		seen.add(filePath);
		result.push({
			path: filePath,
			size: stat.size,
			mtime: stat.mtime,
			extension: getExtensionFromPath(filePath),
		});
	}

	for (const subfolder of listing.folders) {
		if (shouldIgnore(subfolder) || shouldIgnore(subfolder + '/')) continue;
		await walkHiddenFolder(vault, subfolder, shouldIgnore, seen, result);
	}
}

import type { Vault } from 'obsidian';
import { getAllVaultFiles, type VaultFile } from './file-discovery';
import type { FileEntry } from '../protocol/sync-types';

interface LocalFileManifest {
	getAllPaths(): string[];
	getEntry(path: string): FileEntry | undefined;
}

/**
 * Detect missed events using metadata and the engine's rotating content check.
 */
export async function hasLocalFileChanges(
	vault: Vault,
	manifest: LocalFileManifest,
	shouldIgnore: (path: string) => boolean,
	verifyContent?: (files: VaultFile[]) => Promise<boolean>,
): Promise<boolean> {
	const currentFiles = await getAllVaultFiles(vault, shouldIgnore);
	const contentChanged = await verifyContent?.(currentFiles);
	if (contentChanged) return true;
	const currentPaths = new Set(currentFiles.map((file) => file.path));

	for (const file of currentFiles) {
		const tracked = manifest.getEntry(file.path);
		if (!tracked || tracked.size !== file.size || Date.parse(tracked.modified) !== file.mtime) {
			return true;
		}
	}

	for (const path of manifest.getAllPaths()) {
		if (shouldIgnore(path) || currentPaths.has(path)) continue;
		try {
			if (!await vault.adapter.exists(path)) return true;
		} catch {
			// Treat an uncertain adapter result as unchanged until the next check.
		}
	}

	return false;
}

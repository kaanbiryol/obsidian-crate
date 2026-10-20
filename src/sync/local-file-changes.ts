import type { Vault } from 'obsidian';
import { getAllVaultFiles, type VaultFile } from './file-discovery';
import type { FileEntry } from '../protocol/sync-types';
import { MAX_FILE_SIZE_BYTES } from '../protocol/sync-limits';

interface LocalFileManifest {
	getAllPaths(): string[];
	getEntry(path: string): Readonly<FileEntry> | undefined;
}

/**
 * Detect missed events using metadata and the engine's rotating content check.
 */
export async function hasLocalFileChanges(
	vault: Vault,
	manifest: LocalFileManifest,
	shouldIgnore: (path: string) => boolean,
	verifyContent?: (files: VaultFile[]) => Promise<boolean>,
	assertActive?: () => void,
): Promise<boolean> {
	const currentFiles = await getAllVaultFiles(vault, shouldIgnore, assertActive);
	const contentChanged = await verifyContent?.(currentFiles);
	assertActive?.();
	if (contentChanged) return true;
	const currentPaths = new Set(currentFiles.map((file) => file.path));

	for (const file of currentFiles) {
		// Oversized files are skipped by sync, so they never settle into the manifest.
		if (file.size > MAX_FILE_SIZE_BYTES) continue;
		const tracked = manifest.getEntry(file.path);
		if (!tracked || tracked.size !== file.size || Date.parse(tracked.modified) !== file.mtime) {
			return true;
		}
	}

	for (const path of manifest.getAllPaths()) {
		assertActive?.();
		if (shouldIgnore(path) || currentPaths.has(path)) continue;
		try {
			const exists = await vault.adapter.exists(path);
			assertActive?.();
			if (!exists) return true;
		} catch {
			assertActive?.();
			// Treat an uncertain adapter result as unchanged until the next check.
		}
	}

	return false;
}

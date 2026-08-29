import type { Vault } from 'obsidian';
import type { FileEntry } from '../plugin/types';
import { getAllVaultFiles, isHiddenPath } from './file-discovery';

interface HiddenFileManifest {
	getAllPaths(): string[];
	getEntry(path: string): FileEntry | undefined;
}

function modifiedIso(mtime: number): string {
	return new Date(mtime).toISOString();
}

export async function hasHiddenFileChanges(
	vault: Vault,
	manifest: HiddenFileManifest,
	shouldIgnore: (path: string) => boolean,
): Promise<boolean> {
	const currentFiles = (await getAllVaultFiles(vault, shouldIgnore))
		.filter((file) => isHiddenPath(file.path));
	const currentPaths = new Set(currentFiles.map((file) => file.path));

	for (const file of currentFiles) {
		const tracked = manifest.getEntry(file.path);
		if (!tracked || tracked.size !== file.size || tracked.modified !== modifiedIso(file.mtime)) {
			return true;
		}
	}

	for (const path of manifest.getAllPaths()) {
		if (!isHiddenPath(path) || shouldIgnore(path) || currentPaths.has(path)) continue;
		try {
			if (!await vault.adapter.exists(path)) return true;
		} catch {
			// A transient adapter failure must not be interpreted as a deletion.
		}
	}

	return false;
}

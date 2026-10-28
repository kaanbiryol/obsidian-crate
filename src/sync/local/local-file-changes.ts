import type { Vault } from 'obsidian';
import { getAllVaultFiles, type VaultFile } from './file-discovery';
import type { FileEntry } from '../../protocol/sync-types';
import { MAX_FILE_SIZE_BYTES } from '../../protocol/sync-limits';
import { fitsEncryptedPathLimit } from '../../encryption/path-tags';
import { deepEncryptedFileIssue, skippedFileIssue } from '../issues';
import type { SyncIssue } from '../types';

/** Oversized files stay discovered (never local deletes) but sync never transfers them. */
export const isOversizedSyncFile = (file: Pick<VaultFile, 'size'>): boolean => file.size > MAX_FILE_SIZE_BYTES;

/** Why sync leaves a local file out, if it does: it is oversized, or too deep for an encrypted vault.
 * Such files stay discovered but are never uploaded, so they cannot fail every sync. */
export function skippedUploadIssue(file: Pick<VaultFile, 'path' | 'size'>, encrypted: boolean): SyncIssue | null {
	if (isOversizedSyncFile(file)) return skippedFileIssue(file.path);
	return encrypted && !fitsEncryptedPathLimit(file.path) ? deepEncryptedFileIssue(file.path) : null;
}

/** Untracked, resized or retimed files need their bytes checked; an unreadable baseline time counts as changed. */
export function hasLocalMetadataChange(file: Pick<VaultFile, 'size' | 'mtime'>, entry: Pick<FileEntry, 'size' | 'modified'> | undefined): boolean {
	return !entry || entry.size !== file.size || Date.parse(entry.modified) !== file.mtime;
}

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
		if (!isOversizedSyncFile(file) && hasLocalMetadataChange(file, manifest.getEntry(file.path))) return true;
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

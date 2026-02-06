/**
 * Conflict detection and resolution
 */

import type { Vault, TFile } from 'obsidian';
import { createLogger } from '../logger';
import type { FileEntry, FileDiff } from '../types';
import { isHiddenPath } from './file-discovery';

const logger = createLogger('Conflict');

/**
 * Generate conflict file name
 * Format: filename (conflict YYYY-MM-DD HH-mm).ext
 */
export function getConflictFileName(originalPath: string): string {
	const now = new Date();
	const timestamp = now.toISOString()
		.replace('T', ' ')
		.replace(/:/g, '-')
		.substring(0, 16); // YYYY-MM-DD HH-mm

	const lastDot = originalPath.lastIndexOf('.');
	if (lastDot === -1) {
		return `${originalPath} (conflict ${timestamp})`;
	}

	const name = originalPath.substring(0, lastDot);
	const ext = originalPath.substring(lastDot);
	return `${name} (conflict ${timestamp})${ext}`;
}

/**
 * Detect conflicts between local and remote manifests
 */
export function detectConflicts(
	localFiles: Record<string, FileEntry>,
	remoteFiles: Record<string, FileEntry>,
	lastSyncTime: string | null,
): FileDiff[] {
	const diffs: FileDiff[] = [];
	const allPaths = new Set([
		...Object.keys(localFiles),
		...Object.keys(remoteFiles),
	]);

	for (const path of allPaths) {
		const local = localFiles[path];
		const remote = remoteFiles[path];

		if (local && remote) {
			// Both exist - check for conflict or sync needed
			if (local.hash !== remote.hash) {
				const localModified = new Date(local.modified);
				const remoteModified = new Date(remote.modified);
				const lastSync = lastSyncTime ? new Date(lastSyncTime) : new Date(0);

				const localChangedAfterSync = localModified > lastSync;
				const remoteChangedAfterSync = remoteModified > lastSync;

				if (localChangedAfterSync && remoteChangedAfterSync) {
					diffs.push({
						path,
						action: 'conflict',
						localHash: local.hash,
						remoteHash: remote.hash,
					});
				} else if (localChangedAfterSync) {
					diffs.push({
						path,
						action: 'upload',
						localHash: local.hash,
						remoteHash: remote.hash,
					});
				} else {
					diffs.push({
						path,
						action: 'download',
						localHash: local.hash,
						remoteHash: remote.hash,
					});
				}
			}
			// If hashes match, files are in sync - no action needed
		} else if (local && !remote) {
			// Local only - needs upload (new file)
			diffs.push({
				path,
				action: 'upload',
				localHash: local.hash,
			});
		} else if (!local && remote) {
			// Remote only - needs download (new file from another device)
			diffs.push({
				path,
				action: 'download',
				remoteHash: remote.hash,
			});
		}
	}

	return diffs;
}

/**
 * Create a conflict copy of a file.
 * Uses the low-level adapter for hidden paths (dot-prefixed) since
 * Obsidian's vault API doesn't handle them.
 */
export async function createConflictCopy(
	vault: Vault,
	originalPath: string,
	content: ArrayBuffer
): Promise<string> {
	const conflictPath = getConflictFileName(originalPath);

	// Create parent folders if needed
	const folderPath = conflictPath.substring(0, conflictPath.lastIndexOf('/'));
	if (folderPath) {
		if (isHiddenPath(conflictPath)) {
			try {
				await vault.adapter.mkdir(folderPath);
			} catch {
				// Folder might already exist
			}
		} else {
			try {
				await vault.createFolder(folderPath);
			} catch {
				// Folder might already exist
			}
		}
	}

	if (isHiddenPath(conflictPath)) {
		await vault.adapter.writeBinary(conflictPath, content);
	} else {
		await vault.createBinary(conflictPath, content);
	}
	logger.info('Created conflict copy:', conflictPath);
	return conflictPath;
}

/**
 * Check if a file is a conflict copy
 */
export function isConflictFile(path: string): boolean {
	return /\(conflict \d{4}-\d{2}-\d{2} \d{2}-\d{2}\)/.test(path);
}

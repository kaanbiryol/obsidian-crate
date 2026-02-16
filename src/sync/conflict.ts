/**
 * Conflict detection and resolution
 */

import { Notice, type Vault, type TFile } from 'obsidian';
import { createLogger } from '../logger';
import type { FileEntry, FileDiff } from '../types';
import { isHiddenPath } from './file-discovery';

const logger = createLogger('Conflict');

/**
 * Generate conflict file name
 * Format: filename (conflict YYYY-MM-DD HH-mm-ss xxxx).ext
 * Includes seconds and a 4-char random suffix to avoid collisions.
 */
export function getConflictFileName(originalPath: string): string {
	const now = new Date();
	const timestamp = now.toISOString()
		.replace('T', ' ')
		.replace(/:/g, '-')
		.substring(0, 19); // YYYY-MM-DD HH-mm-ss

	const suffix = Math.random().toString(36).substring(2, 6);
	const tag = `conflict ${timestamp} ${suffix}`;

	const lastDot = originalPath.lastIndexOf('.');
	if (lastDot === -1) {
		return `${originalPath} (${tag})`;
	}

	const name = originalPath.substring(0, lastDot);
	const ext = originalPath.substring(lastDot);
	return `${name} (${tag})${ext}`;
}

/**
 * Detect conflicts between local and remote manifests using 3-way hash comparison.
 * The manifestEntries parameter provides the common ancestor (last known synced state)
 * to determine which side changed, avoiding timestamp-based decisions that break under clock skew.
 */
export function detectConflicts(
	localFiles: Record<string, FileEntry>,
	remoteFiles: Record<string, FileEntry>,
	manifestEntries: Record<string, FileEntry>,
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
			if (local.hash === remote.hash) continue; // in sync

			const manifestHash = manifestEntries[path]?.hash;

			if (!manifestHash) {
				// New file on both sides with different content → conflict
				diffs.push({ path, action: 'conflict', localHash: local.hash, remoteHash: remote.hash });
			} else if (local.hash !== manifestHash && remote.hash !== manifestHash) {
				// Both sides changed since last sync → conflict
				diffs.push({ path, action: 'conflict', localHash: local.hash, remoteHash: remote.hash });
			} else if (local.hash !== manifestHash) {
				// Only local changed → upload
				diffs.push({ path, action: 'upload', localHash: local.hash, remoteHash: remote.hash });
			} else {
				// Only remote changed (or local unchanged) → download
				diffs.push({ path, action: 'download', localHash: local.hash, remoteHash: remote.hash });
			}
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
	new Notice(`Sync conflict: ${originalPath}\nLocal version saved as conflict copy, remote version kept as original.`);
	return conflictPath;
}

/**
 * Check if a file is a conflict copy
 */
export function isConflictFile(path: string): boolean {
	return /\(conflict \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2} [a-z0-9]{4}\)/.test(path);
}

/**
 * Show a persistent notice summarizing conflicts from a background sync.
 * Duration 0 = user must dismiss manually.
 */
export function notifyConflicts(conflictPaths: string[]): void {
	if (conflictPaths.length === 0) return;

	const message = conflictPaths.length === 1
		? `Sync conflict: ${conflictPaths[0]}\nLocal version saved as conflict copy.`
		: `${conflictPaths.length} sync conflicts detected.\nSearch your vault for "conflict" to find the copies.`;

	new Notice(message, 0);
}

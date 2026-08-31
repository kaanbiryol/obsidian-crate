/**
 * Conflict detection and resolution
 */

import { Notice, type Vault } from 'obsidian';
import { createLogger } from '../plugin/logger';
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
	return /\(conflict \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2} [a-z0-9]{4}\)/.test(path);
}

/**
 * Show a persistent notice summarizing conflicts from a background sync.
 * Duration 0 = user must dismiss manually.
 */
export function notifyConflicts(conflictPaths: string[]): void {
	if (conflictPaths.length === 0) return;

	const message = conflictPaths.length === 1
		? `Sync conflict: ${conflictPaths[0]}\nReview the affected file; a local version may have been saved as a conflict copy.`
		: `${conflictPaths.length} sync conflicts detected.\nReview the affected files and any conflict copies.`;

	new Notice(message, 0);
}

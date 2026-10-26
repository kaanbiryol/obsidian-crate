/**
 * Conflict detection and resolution
 */

import { Notice, type Vault } from 'obsidian';
import { createLogger } from '../logger';
import { ensureParentFolder, insertBeforeExtension } from '../local/file-discovery';

const logger = createLogger('Conflict');
const CONFLICT_TAG_PATTERN = / \(conflict (?:\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2} [a-z0-9]{4}|remote [a-f0-9]{64}(?:-\d+)?)\)(?=\.[^/]+$|$)/;

export function getIncomingConflictFileName(path: string, hash: string, variant = 0): string {
	return insertBeforeExtension(path, ` (conflict remote ${hash}${variant ? `-${variant}` : ''})`);
}

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
	return insertBeforeExtension(originalPath, ` (conflict ${timestamp} ${suffix})`);
}

/**
 * Create a conflict copy of a file.
 * The host create checks existence for hidden paths too; unlike adapter writes,
 * it refuses to overwrite a colliding or concurrently created recovery copy.
 */
export async function createConflictCopy(
	vault: Vault,
	originalPath: string,
	content: ArrayBuffer
): Promise<string> {
	const conflictPath = getConflictFileName(originalPath);
	await ensureParentFolder(vault, conflictPath);
	await vault.createBinary(conflictPath, content);
	logger.info('Created conflict copy:', conflictPath);
	return conflictPath;
}

/**
 * Check if a file is a conflict copy
 */
export function isConflictFile(path: string): boolean {
	return CONFLICT_TAG_PATTERN.test(path);
}

export function getOriginalPathFromConflictFile(path: string): string | null {
	if (!isConflictFile(path)) return null;
	return path.replace(CONFLICT_TAG_PATTERN, '');
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

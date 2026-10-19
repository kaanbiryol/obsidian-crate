import { sha256Hex } from '../platform/sha256';

/**
 * File hashing utilities using SHA-256 for change detection
 */

/**
 * Compute SHA-256 hash of content
 * Using a simple implementation suitable for change detection (not security)
 */
export async function computeHash(content: ArrayBuffer): Promise<string> {
	return sha256Hex(content);
}


/**
 * File hashing utilities using SHA-256 for change detection
 */

/**
 * Compute SHA-256 hash of content
 * Using a simple implementation suitable for change detection (not security)
 */
export async function computeHash(content: ArrayBuffer): Promise<string> {
	// Use SubtleCrypto for hashing (available in both browser and Node)
	const hashBuffer = await crypto.subtle.digest('SHA-256', content);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}


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

/**
 * Compute hash from string content
 */
export async function computeStringHash(content: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(content);
	return computeHash(data.buffer as ArrayBuffer);
}

/**
 * Check if content matches expected hash
 */
export async function verifyHash(content: ArrayBuffer, expectedHash: string): Promise<boolean> {
	const actualHash = await computeHash(content);
	return actualHash === expectedHash;
}

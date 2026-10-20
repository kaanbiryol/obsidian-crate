/** Lowercase hex SHA-256 of UTF-8 text or raw bytes. */
export async function sha256Hex(value: string | BufferSource | Uint8Array): Promise<string> {
	// Web Crypto reads any typed array; TypeScript narrows BufferSource to ArrayBuffer-backed views.
	const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value as BufferSource;
	return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

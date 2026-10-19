/** Lowercase hex SHA-256 of UTF-8 text or raw bytes. */
export async function sha256Hex(value: string | BufferSource): Promise<string> {
	const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
	return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

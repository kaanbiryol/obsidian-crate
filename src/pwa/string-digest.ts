/** Stable UTF-8 SHA-256 encoding shared by enrollment and request identities. */
export async function stringDigest(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

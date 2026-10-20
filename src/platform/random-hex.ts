/** Credential-grade random bytes as lowercase hex; 32 bytes by default. */
export function createRandomHexToken(byteLength = 32): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(byteLength)), byte => byte.toString(16).padStart(2, '0')).join('');
}

import { getSyncPathIssue } from './portable-path';

/** Encrypted vaults store each folder and file name as a 26-character lowercase
 * tag, keeping only `.md` readable. Lowercase wire paths are their own portable
 * form, so the server's identity, folder and Markdown rules apply unchanged. */
const WIRE_SEGMENT = /^[a-z2-7]{26}(\.md)?$/;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32 in lowercase, without padding. */
export function encodeBase32(bytes: Uint8Array): string {
	let result = '', buffer = 0, bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte; bits += 8;
		while (bits >= 5) { result += ALPHABET[(buffer >>> (bits - 5)) & 31]; bits -= 5; }
	}
	return bits ? result + ALPHABET[(buffer << (5 - bits)) & 31] : result;
}

export function isWireSegment(segment: string): boolean { return WIRE_SEGMENT.test(segment); }

export function isWirePath(path: string): boolean {
	return !getSyncPathIssue(path) && path.split('/').every(isWireSegment);
}

/** A random note name for a party without the path key: the iPhone shortcut's server. */
export function createOpaqueWireName(): string {
	return `${encodeBase32(crypto.getRandomValues(new Uint8Array(16)))}.md`;
}

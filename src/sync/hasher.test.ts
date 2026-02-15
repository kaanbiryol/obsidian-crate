import { describe, expect, it } from 'vitest';
import { computeHash } from './hasher';

async function computeStringHash(content: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(content);
	return computeHash(data.buffer as ArrayBuffer);
}

async function verifyHash(content: ArrayBuffer, expectedHash: string): Promise<boolean> {
	const actualHash = await computeHash(content);
	return actualHash === expectedHash;
}

describe('hasher', () => {
	it('computes a stable SHA-256 hash for known bytes', async () => {
		const content = new TextEncoder().encode('hello').buffer as ArrayBuffer;
		const hash = await computeHash(content);
		expect(hash).toBe(
			'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
		);
	});

	it('computeStringHash matches computeHash on encoded content', async () => {
		const text = 'same-content';
		const encoded = new TextEncoder().encode(text).buffer as ArrayBuffer;

		await expect(computeStringHash(text)).resolves.toBe(await computeHash(encoded));
	});

	it('verifyHash returns true for matching hash and false for mismatch', async () => {
		const content = new TextEncoder().encode('crate').buffer as ArrayBuffer;
		const goodHash = await computeHash(content);

		await expect(verifyHash(content, goodHash)).resolves.toBe(true);
		await expect(verifyHash(content, 'deadbeef')).resolves.toBe(false);
	});
});

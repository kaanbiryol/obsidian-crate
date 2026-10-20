import { describe, expect, it } from 'vitest';
import { sha256Hex } from './sha256';

async function computeStringHash(content: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(content);
	return sha256Hex(data.buffer);
}

async function verifyHash(content: ArrayBuffer, expectedHash: string): Promise<boolean> {
	const actualHash = await sha256Hex(content);
	return actualHash === expectedHash;
}

describe('sha256Hex', () => {
	it('computes a stable SHA-256 hash for known bytes', async () => {
		const content = new TextEncoder().encode('hello').buffer;
		const hash = await sha256Hex(content);
		expect(hash).toBe(
			'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
		);
	});

	it('computeStringHash matches sha256Hex on encoded content', async () => {
		const text = 'same-content';
		const encoded = new TextEncoder().encode(text).buffer;

		await expect(computeStringHash(text)).resolves.toBe(await sha256Hex(encoded));
	});

	it('verifyHash returns true for matching hash and false for mismatch', async () => {
		const content = new TextEncoder().encode('crate').buffer;
		const goodHash = await sha256Hex(content);

		await expect(verifyHash(content, goodHash)).resolves.toBe(true);
		await expect(verifyHash(content, 'deadbeef')).resolves.toBe(false);
	});
});

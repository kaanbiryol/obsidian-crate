import { describe, expect, it } from 'vitest';
import { generateEncryptionSecret, importEncryptionSecret } from './envelope';
import { decodeBase64Url, encodeBase64Url } from './encoding';
import { openFile, openFileMetadata, sealFile } from './file-codec';
import { encodeEncryptedFile, isEncryptedFile, parseEncryptedFile, validateFileDescriptor } from './file-format';

const input = { path: 'Reminders/Private project.md', content: new TextEncoder().encode('- [ ] Secret appointment'), publicData: { at: '2099-01-01T12:00:00Z' } };
const authority = async () => ({ vaultId: 'vault-a', scopeId: 'reminders-a', key: await importEncryptionSecret(generateEncryptionSecret()) });

describe('encrypted file transport', () => {
	it('keeps content, path binding, and plaintext digest inside encrypted envelopes', async () => {
		const owner = await authority();
		const file = await sealFile(input, owner);
		const wire = new TextDecoder().decode(file.bytes);
		for (const privateValue of [input.path, 'Secret appointment', file.metadata.hash]) expect(wire).not.toContain(privateValue);
		expect(file.hash).not.toBe(file.metadata.hash);
		expect(isEncryptedFile(file.bytes)).toBe(true);
		expect(await openFileMetadata(file.descriptor, input.path, owner)).toEqual(file.metadata);
		expect(await openFile(file.bytes, input.path, owner)).toEqual({ content: input.content, metadata: file.metadata, publicData: input.publicData });
	});

	it('refuses a copied file at another path or in another vault', async () => {
		const owner = await authority();
		const file = await sealFile(input, owner);
		await expect(openFile(file.bytes, 'Reminders/Other.md', owner)).rejects.toThrow();
		await expect(openFile(file.bytes, input.path, { ...owner, vaultId: 'another' })).rejects.toThrow();
	});

	it('authenticates the public scheduling metadata and binds file bytes to their descriptor', async () => {
		const owner = await authority();
		const first = await sealFile(input, owner);
		const second = await sealFile({ ...input, content: new TextEncoder().encode('Other content') }, owner);
		const packet = parseEncryptedFile(first.bytes);
		await expect(openFile(encodeEncryptedFile({ ...packet, publicData: { at: '2099-02-01T12:00:00Z' } }), input.path, owner)).rejects.toThrow();
		await expect(openFile(encodeEncryptedFile({ ...packet, ciphertext: parseEncryptedFile(second.bytes).ciphertext }), input.path, owner)).rejects.toThrow();
	});

	it('preserves the full 25 MiB plaintext file limit', async () => {
		const owner = await authority();
		const content = new Uint8Array(25 * 1024 * 1024);
		content[0] = 128;
		content[content.length - 1] = 255;
		const file = await sealFile({ ...input, content, publicData: null }, owner);
		const opened = await openFile(file.bytes, input.path, owner);
		expect(opened.content.byteLength).toBe(content.length);
		expect(opened.content[0]).toBe(128);
		expect(opened.content.at(-1)).toBe(255);
	}, 15_000);

	it('seals metadata in a compact envelope bound to the descriptor', async () => {
		const owner = await authority();
		const path = '\uFEFFCafé/Ünïcødé.md';
		const file = await sealFile({ ...input, path }, owner);
		expect(file.descriptor.version).toBe(1);
		expect(file.descriptor.metadata).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(file.descriptor.metadata.length).toBeLessThan(220);
		expect(await openFileMetadata(file.descriptor, path, owner)).toEqual({ version: 1, path, hash: file.metadata.hash, size: file.metadata.size, publicDataHash: file.metadata.publicDataHash });
		for (const field of ['vaultId', 'scopeId', 'objectId', 'keyId'] as const) {
			const other = field === 'keyId' ? { ...owner, key: { ...owner.key, id: 'other' } } : { ...owner, [field]: 'other' };
			await expect(openFileMetadata({ ...file.descriptor, [field]: 'other' }, path, other)).rejects.toThrow();
		}
		await expect(openFileMetadata(file.descriptor, path, { ...owner, key: await importEncryptionSecret(generateEncryptionSecret()) })).rejects.toThrow();
	});

	it('rejects every changed, missing or added byte of the envelope', async () => {
		const owner = await authority();
		const file = await sealFile(input, owner);
		const bytes = decodeBase64Url(file.descriptor.metadata, 6144);
		const flip = (index: number) => { const copy = bytes.slice(); copy[index]! ^= 1; return copy; };
		// The wrapped key, the IV, the ciphertext and the tag.
		const edits = [flip(0), flip(39), flip(40), flip(51), flip(52), flip(bytes.length - 17), flip(bytes.length - 1),
			bytes.slice(0, -1), bytes.slice(1), Uint8Array.from([...bytes, 0])];
		for (const edited of edits) {
			await expect(openFileMetadata({ ...file.descriptor, metadata: encodeBase64Url(edited) }, input.path, owner)).rejects.toThrow();
		}
		// One encoding per envelope: padding or set trailing bits are refused before decryption.
		const short = encodeBase64Url(bytes.slice(0, bytes.length - (bytes.length % 3) - 2));
		const loose = short.slice(0, -1) + (short.at(-1) === 'B' ? 'C' : 'B');
		for (const metadata of [file.descriptor.metadata + '=', loose]) {
			expect(() => validateFileDescriptor({ ...file.descriptor, metadata })).toThrow();
		}
	});

	it('refuses a descriptor moved onto another file and names it cannot keep', async () => {
		const owner = await authority();
		const first = await sealFile(input, owner);
		const second = await sealFile({ ...input, path: 'Reminders/Other.md' }, owner);
		await expect(openFileMetadata(second.descriptor, input.path, owner)).rejects.toThrow();
		const packet = parseEncryptedFile(first.bytes);
		await expect(openFile(encodeEncryptedFile({ ...packet, descriptor: second.descriptor }), 'Reminders/Other.md', owner)).rejects.toThrow();
		// UTF-8 cannot hold a lone surrogate, which would reach other devices as another name.
		await expect(sealFile({ ...input, path: 'Reminders/a\uD800b.md' }, owner)).rejects.toThrow('not valid Unicode');
		// A path that fits the descriptor's limit only as UTF-16 is refused when sealing.
		await expect(sealFile({ ...input, path: 'é'.repeat(4000) }, owner)).rejects.toThrow('too large');
	});

	it('rejects an unsupported encryption format instead of reading it as Markdown', () => {
		const future = 'CRATE-E2EE/2\n{}';
		expect(isEncryptedFile(future)).toBe(true);
		expect(() => parseEncryptedFile(future)).toThrow('Unsupported');
	});
});

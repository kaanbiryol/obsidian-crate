import { describe, expect, it } from 'vitest';
import { generateEncryptionSecret, importEncryptionSecret } from './envelope';
import { openFile, openFileMetadata, sealFile } from './file-codec';
import { encodeEncryptedFile, isEncryptedFile, parseEncryptedFile } from './file-format';

const input = { path: 'Reminders/Private project.md', content: new TextEncoder().encode('- [ ] Secret appointment'), contentType: 'text/markdown', publicData: { at: '2099-01-01T12:00:00Z' } };
const authority = async () => ({ vaultId: 'vault-a', scopeId: 'reminders-a', key: await importEncryptionSecret(generateEncryptionSecret()) });

describe('encrypted file transport', () => {
	it('keeps content, MIME type, path binding, and plaintext digest inside encrypted envelopes', async () => {
		const owner = await authority();
		const file = await sealFile(input, owner);
		const wire = new TextDecoder().decode(file.bytes);
		for (const privateValue of [input.path, input.contentType, 'Secret appointment', file.metadata.hash]) expect(wire).not.toContain(privateValue);
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

	it('rejects an unsupported encryption format instead of reading it as Markdown', () => {
		const future = 'CRATE-E2EE/2\n{}';
		expect(isEncryptedFile(future)).toBe(true);
		expect(() => parseEncryptedFile(future)).toThrow('Unsupported');
	});
});

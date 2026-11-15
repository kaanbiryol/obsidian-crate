import { describe, expect, it } from 'vitest';
import { generateEncryptionSecret, importEncryptionSecret } from '../../../encryption/envelope';
import { sealFile } from '../../../encryption/file-codec';
import type { EncryptedFileDescriptor } from '../../../encryption/file-format';
import { packDescriptor, unpackDescriptor } from './descriptor-column';

const VAULT = '263d20c2-de47-459a-b603-973181a5b6d4';
// Packed format sample: it must keep reading back this exact descriptor.
const PACKED = '1.Jj0gwt5HRZq2A5cxgaW21A.Ponk8LJNRm6zk7mGLz4z7w.VWpy4e-zSgSiRn5MDBhcXA.ZW52ZWxvcGU';
const DESCRIPTOR: EncryptedFileDescriptor = {
	version: 1, vaultId: VAULT, scopeId: 'vault', objectId: '3e89e4f0-b24d-466e-b393-b9862f3e33ef', keyId: '556a72e1-efb3-4a04-a246-7e4c0c185c5c',
	metadata: 'ZW52ZWxvcGU',
};

async function sealedDescriptor(path = 'Projects/Work/Meeting notes.md'): Promise<EncryptedFileDescriptor> {
	const key = await importEncryptionSecret(generateEncryptionSecret());
	return (await sealFile({ path, content: new TextEncoder().encode('# sample') },
		{ vaultId: VAULT, scopeId: 'vault', key })).descriptor;
}

describe('descriptor column', () => {
	it('packs a sealed descriptor and rebuilds every byte of it', async () => {
		const descriptor = await sealedDescriptor();
		const json = JSON.stringify(descriptor);
		const packed = packDescriptor(descriptor);
		expect(packed.startsWith('1.')).toBe(true);
		expect(packed.length).toBeLessThan(330);
		expect(packed.length).toBeLessThan(json.length - 100);
		expect(JSON.stringify(unpackDescriptor(packed))).toBe(json);
	});

	it('reads and writes the packed format', () => {
		expect(unpackDescriptor(PACKED)).toEqual(DESCRIPTOR);
		expect(packDescriptor(DESCRIPTOR)).toBe(PACKED);
	});

	it('keeps the JSON of a descriptor the packed form would not rebuild exactly', async () => {
		const descriptor = await sealedDescriptor();
		const variants: EncryptedFileDescriptor[] = [
			{ ...descriptor, scopeId: 'folder' },
			{ ...descriptor, keyId: 'not-a-uuid' },
			{ ...descriptor, objectId: descriptor.objectId.toUpperCase() },
			{ ...descriptor, metadata: `${descriptor.metadata}.extra` },
			{ metadata: descriptor.metadata, version: 1, vaultId: descriptor.vaultId, scopeId: 'vault', objectId: descriptor.objectId, keyId: descriptor.keyId },
		];
		for (const variant of variants) {
			const stored = packDescriptor(variant);
			expect(stored).toBe(JSON.stringify(variant));
			expect(unpackDescriptor(stored)).toEqual(variant);
		}
	});

	it('rejects a damaged packed descriptor', () => {
		for (const damaged of ['1.short', PACKED.replace('1.', '2.'), PACKED + '.extra', PACKED.replace('Jj0gwt5HRZq2A5cxgaW21A', 'Jj0g')]) {
			expect(() => unpackDescriptor(damaged)).toThrow();
		}
	});
});

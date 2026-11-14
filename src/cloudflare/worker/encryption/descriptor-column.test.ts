import { describe, expect, it } from 'vitest';
import { generateEncryptionSecret, importEncryptionSecret } from '../../../encryption/envelope';
import { sealFile } from '../../../encryption/file-codec';
import type { EncryptedFileDescriptor } from '../../../encryption/file-format';
import { packDescriptor, unpackDescriptor } from './descriptor-column';

const VAULT = '263d20c2-de47-459a-b603-973181a5b6d4';
// Packed format samples: they must keep reading back these exact descriptors.
const PACKED_V1 = '1.Jj0gwt5HRZq2A5cxgaW21A.Ponk8LJNRm6zk7mGLz4z7w.VWpy4e-zSgSiRn5MDBhcXA.d3JhcHBlZA.aXY.Y2lwaGVy.dGFn';
const V1: EncryptedFileDescriptor = {
	version: 1, vaultId: VAULT, scopeId: 'vault', objectId: '3e89e4f0-b24d-466e-b393-b9862f3e33ef', keyId: '556a72e1-efb3-4a04-a246-7e4c0c185c5c',
	metadata: 'eyJhbGciOiJBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIiwidHlwIjoiY3JhdGUtZTJlZStqd2UiLCJ2IjoxLCJraWQiOiI1NTZhNzJlMS1lZmIzLTRhMDQtYTI0Ni03ZTRjMGMxODVjNWMiLCJ2YXVsdCI6IjI2M2QyMGMyLWRlNDctNDU5YS1iNjAzLTk3MzE4MWE1YjZkNCIsInNjb3BlIjoidmF1bHQiLCJvYmplY3QiOiIzZTg5ZTRmMC1iMjRkLTQ2NmUtYjM5My1iOTg2MmYzZTMzZWYiLCJwdXJwb3NlIjoiZmlsZS1tZXRhZGF0YSJ9.d3JhcHBlZA.aXY.Y2lwaGVy.dGFn',
};
const PACKED_V2 = '2.Jj0gwt5HRZq2A5cxgaW21A.Ponk8LJNRm6zk7mGLz4z7w.VWpy4e-zSgSiRn5MDBhcXA.ZW52ZWxvcGU';
const V2: EncryptedFileDescriptor = { ...V1, version: 2, metadata: 'ZW52ZWxvcGU' };

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
		expect(packed.startsWith('2.')).toBe(true);
		expect(packed.length).toBeLessThan(330);
		expect(packed.length).toBeLessThan(json.length - 100);
		expect(JSON.stringify(unpackDescriptor(packed))).toBe(json);
	});

	it('reads and writes both packed formats', () => {
		for (const [packed, descriptor] of [[PACKED_V1, V1], [PACKED_V2, V2]] as const) {
			expect(unpackDescriptor(packed)).toEqual(descriptor);
			expect(packDescriptor(descriptor)).toBe(packed);
		}
	});

	it('keeps the JSON of a descriptor the packed form would not rebuild exactly', async () => {
		const descriptor = await sealedDescriptor();
		const [, ...envelope] = V1.metadata.split('.');
		const variants: EncryptedFileDescriptor[] = [
			// A version 1 header other than the frozen one.
			{ ...V1, metadata: [btoa('{"alg":"A256KW"}').replace(/=+$/, ''), ...envelope].join('.') },
			{ ...descriptor, scopeId: 'folder' },
			{ ...descriptor, keyId: 'not-a-uuid' },
			{ ...descriptor, objectId: descriptor.objectId.toUpperCase() },
			{ ...descriptor, metadata: `${descriptor.metadata}.extra` },
			{ metadata: descriptor.metadata, version: 2, vaultId: descriptor.vaultId, scopeId: 'vault', objectId: descriptor.objectId, keyId: descriptor.keyId },
		];
		for (const variant of variants) {
			const stored = packDescriptor(variant);
			expect(stored).toBe(JSON.stringify(variant));
			expect(unpackDescriptor(stored)).toEqual(variant);
		}
	});

	it('rejects a damaged packed descriptor', () => {
		for (const damaged of ['1.short', PACKED_V1.replace('1.', '3.'), PACKED_V1 + '.extra', PACKED_V2 + '.extra', PACKED_V1.replace('Jj0gwt5HRZq2A5cxgaW21A', 'Jj0g')]) {
			expect(() => unpackDescriptor(damaged)).toThrow();
		}
	});
});

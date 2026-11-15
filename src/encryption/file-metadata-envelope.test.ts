import { describe, expect, it } from 'vitest';
import { decodeBase64Url, encodeBase64Url } from './encoding';
import { generateEncryptionSecret, importEncryptionSecret } from './envelope';
import { MAX_FILE_METADATA_ENVELOPE_BYTES, MIN_FILE_METADATA_ENVELOPE_BYTES, openFileMetadataEnvelope, sealFileMetadata } from './file-metadata-envelope';

const fields = { path: 'Private/Café plan.md', hash: 'ab'.repeat(32), size: 4_000_000_000, publicDataHash: '0f'.repeat(32) };
const ids = { vaultId: 'vault-a', scopeId: 'vault', objectId: 'object-a', keyId: 'key-a' };
const key = async () => ({ ...(await importEncryptionSecret(generateEncryptionSecret())), id: ids.keyId });
const mismatch = 'Encrypted data belongs to another vault, scope, object, or key version';

describe('compact file metadata envelopes', () => {
	it('round-trips the private fields without exposing the path', async () => {
		const k = await key();
		const sealed = await sealFileMetadata(fields, k, ids);
		expect(sealed).not.toContain('Private');
		expect(await openFileMetadataEnvelope(sealed, k, ids)).toEqual(fields);
		const shortest = await sealFileMetadata({ ...fields, path: 'a' }, k, ids);
		expect(decodeBase64Url(shortest, MAX_FILE_METADATA_ENVELOPE_BYTES)).toHaveLength(MIN_FILE_METADATA_ENVELOPE_BYTES);
	});

	it.each(Object.keys(ids) as (keyof typeof ids)[])('binds %s as additional data', async field => {
		const k = await key();
		const sealed = await sealFileMetadata(fields, k, ids);
		await expect(openFileMetadataEnvelope(sealed, k, { ...ids, [field]: 'other' })).rejects.toThrow(mismatch);
	});

	it('rejects another key, tampered bytes and truncated envelopes', async () => {
		const k = await key();
		const sealed = await sealFileMetadata(fields, k, ids);
		await expect(openFileMetadataEnvelope(sealed, await key(), ids)).rejects.toThrow(mismatch);
		const bytes = decodeBase64Url(sealed, MAX_FILE_METADATA_ENVELOPE_BYTES);
		for (const offset of [0, 40, 60, bytes.length - 1]) {
			const tampered = bytes.slice();
			tampered[offset] = tampered[offset]! ^ 1;
			await expect(openFileMetadataEnvelope(encodeBase64Url(tampered), k, ids)).rejects.toThrow(mismatch);
		}
		await expect(openFileMetadataEnvelope(encodeBase64Url(bytes.slice(0, MIN_FILE_METADATA_ENVELOPE_BYTES - 1)), k, ids)).rejects.toThrow('Invalid encrypted file metadata');
		await expect(openFileMetadataEnvelope(sealed + '=', k, ids)).rejects.toThrow('Invalid encrypted data encoding');
	});

	it('refuses names another device would decode differently, empty names and invalid IDs', async () => {
		const k = await key();
		await expect(sealFileMetadata({ ...fields, path: 'Private/\uD800.md' }, k, ids)).rejects.toThrow('not valid Unicode');
		await expect(sealFileMetadata({ ...fields, path: '' }, k, ids)).rejects.toThrow('not valid Unicode');
		await expect(sealFileMetadata(fields, k, { ...ids, objectId: 'a\nb' })).rejects.toThrow('Invalid encryption context');
		await expect(openFileMetadataEnvelope('A'.repeat(200), k, { ...ids, vaultId: '' })).rejects.toThrow('Invalid encryption context');
		await expect(sealFileMetadata({ ...fields, path: 'a'.repeat(MAX_FILE_METADATA_ENVELOPE_BYTES) }, k, ids)).rejects.toThrow('Encrypted file metadata is too large');
	});
});

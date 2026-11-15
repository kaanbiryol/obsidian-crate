import { describe, expect, it } from 'vitest';
import { ENCRYPTED_FILE_CONTENT_TYPE, encodeEncryptedFile, fileTransportLimit, isEncryptedFile, MAX_ENCRYPTED_FILE_BYTES, MAX_ENCRYPTED_PUBLIC_DATA_BYTES, parseEncryptedFile, validateFileDescriptor, type EncryptedFileDescriptor } from './file-format';
import { MAX_FILE_SIZE_BYTES } from '../protocol/sync-limits';

const descriptor: EncryptedFileDescriptor = { version: 1, vaultId: 'vault-a', scopeId: 'vault', objectId: 'object-a', keyId: 'key-a', metadata: 'A'.repeat(184) };
const ciphertext = 'a.b.c.d.e';
const frame = (header: unknown, body = ciphertext) => `CRATE-E2EE/1\n${JSON.stringify(header)}\n${body}`;

describe('encrypted file framing', () => {
	it('round-trips descriptors, public data and ciphertext as bytes or text', () => {
		const bytes = encodeEncryptedFile({ descriptor, ciphertext, publicData: { at: '2099-01-01' } });
		expect(parseEncryptedFile(bytes)).toEqual({ descriptor, ciphertext, publicData: { at: '2099-01-01' } });
		expect(parseEncryptedFile(new TextDecoder().decode(bytes))).toEqual(parseEncryptedFile(bytes));
	});

	it('recognizes the encrypted prefix only', () => {
		expect(isEncryptedFile('CRATE-E2EE/2\n')).toBe(true);
		expect(isEncryptedFile('# Note')).toBe(false);
		expect(isEncryptedFile(new TextEncoder().encode('CRATE-E2EE'))).toBe(false);
		expect(isEncryptedFile(new TextEncoder().encode('CRATE-E2EF/1'))).toBe(false);
		expect(isEncryptedFile(new TextEncoder().encode('CRATE-E2EE/1'))).toBe(true);
	});

	it('uses the larger transport limit only for encrypted content', () => {
		expect(fileTransportLimit(ENCRYPTED_FILE_CONTENT_TYPE)).toBe(MAX_ENCRYPTED_FILE_BYTES);
		expect(fileTransportLimit('text/markdown')).toBe(MAX_FILE_SIZE_BYTES);
		expect(fileTransportLimit(undefined)).toBe(MAX_FILE_SIZE_BYTES);
	});

	it.each<[string, unknown, string]>([
		['a non-object', [], 'Invalid encrypted file descriptor'],
		['a plaintext path field', { ...descriptor, path: 'Private.md' }, 'Unexpected encrypted file descriptor field'],
		['version 2', { ...descriptor, version: 2 }, 'Unsupported or damaged encrypted file descriptor'],
		['an invalid object ID', { ...descriptor, objectId: 'a/b' }, 'Unsupported or damaged encrypted file descriptor'],
		['oversized metadata', { ...descriptor, metadata: 'A'.repeat(8193) }, 'Unsupported or damaged encrypted file descriptor'],
		['JWE metadata', { ...descriptor, metadata: 'a.b.c.d.e' }, 'Unsupported or damaged encrypted file descriptor'],
		['truncated compact metadata', { ...descriptor, metadata: 'A'.repeat(180) }, 'Unsupported or damaged encrypted file descriptor'],
		['non-string metadata', { ...descriptor, metadata: 5 }, 'Unsupported or damaged encrypted file descriptor'],
	])('rejects a descriptor with %s', (_, value, message) => {
		expect(() => validateFileDescriptor(value)).toThrow(message);
	});

	it('refuses public data that cannot be framed or exceeds its limit', () => {
		expect(() => encodeEncryptedFile({ descriptor, ciphertext, publicData: undefined })).toThrow('Invalid encrypted file scheduling metadata');
		expect(() => encodeEncryptedFile({ descriptor, ciphertext, publicData: 'x'.repeat(MAX_ENCRYPTED_PUBLIC_DATA_BYTES) })).toThrow('Invalid encrypted file scheduling metadata');
		expect(() => encodeEncryptedFile({ descriptor, ciphertext: 'a'.repeat(MAX_ENCRYPTED_FILE_BYTES), publicData: null })).toThrow('Encrypted file exceeds its transport limit');
	});

	it.each<[string, string | Uint8Array<ArrayBuffer>, string | typeof Error]>([
		['plaintext', '# Private note', 'Unsupported encrypted file format'],
		['another format version', 'CRATE-E2EE/2\n{}\na.b.c.d.e', 'Unsupported encrypted file format'],
		['no header terminator', 'CRATE-E2EE/1\n{}', 'Invalid encrypted file header'],
		['an array header', frame([]), 'Invalid encrypted file'],
		['an extra header field', frame({ descriptor, publicData: null, path: 'Private.md' }), 'Unexpected encrypted file header'],
		['a damaged descriptor', frame({ descriptor: { ...descriptor, version: 9 }, publicData: null }), 'Unsupported or damaged encrypted file descriptor'],
		['a non-JWE body', frame({ descriptor, publicData: null }, 'a.b.c.d'), 'Invalid encrypted file content'],
		['missing public data', frame({ descriptor }), 'Invalid encrypted file scheduling metadata'],
		['invalid UTF-8', new Uint8Array([...new TextEncoder().encode('CRATE-E2EE/1\n'), 0xff]), TypeError],
		['an oversized file', 'x'.repeat(MAX_ENCRYPTED_FILE_BYTES + 1), 'Encrypted file exceeds its transport limit'],
	])('rejects a file with %s', (_, value, error) => {
		expect(() => parseEncryptedFile(value)).toThrow(error);
	});

	it('bounds the parsed header before reading the ciphertext', () => {
		const huge = `CRATE-E2EE/1\n${'x'.repeat(MAX_ENCRYPTED_PUBLIC_DATA_BYTES + 16 * 1024 + 1)}\n${ciphertext}`;
		expect(() => parseEncryptedFile(huge)).toThrow('Invalid encrypted file header');
	});
});

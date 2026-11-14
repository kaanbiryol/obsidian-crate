import { decodeBase64Url, encodeBase64Url, isEncryptionId } from './encoding';
import type { EncryptionKey } from './envelope';

/** The private metadata of a version 2 file descriptor, sealed in one compact envelope:
 * base64url(wrapped content key || IV || AES-256-GCM ciphertext and tag). As with JWE
 * A256KW, a fresh content key per envelope is wrapped with the vault key by AES-KW. The
 * descriptor's IDs are bound as additional data instead of being repeated in a header,
 * and the plaintext is binary: content hash, public data hash, size, then the path. A
 * descriptor is stored with every revision's rows, so this keeps it about 220 characters
 * instead of 960. */
const WRAPPED_KEY = 40, IV = 12, TAG = 16, HASH = 32;
const FIXED = HASH * 2 + 4;
/** Smallest valid envelope: a one-byte path. */
export const MIN_FILE_METADATA_ENVELOPE_BYTES = WRAPPED_KEY + IV + FIXED + 1 + TAG;
/** The descriptor field's 8,192-character limit. */
export const MAX_FILE_METADATA_ENVELOPE_BYTES = 6144;

export interface FileMetadataFields { path: string; hash: string; size: number; publicDataHash: string }
export interface FileMetadataIds { vaultId: string; scopeId: string; objectId: string; keyId: string }

/** The IDs can hold no separator, so the joined data names exactly one set of IDs. */
function additionalData(ids: FileMetadataIds): Uint8Array<ArrayBuffer> {
	const values = [ids.vaultId, ids.scopeId, ids.objectId, ids.keyId];
	if (!values.every(isEncryptionId)) throw new Error('Invalid encryption context');
	return new TextEncoder().encode(['crate-e2ee-v2/file-metadata', ...values].join('\n'));
}
const hexBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, byte => parseInt(byte, 16));
const bytesHex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function encodeFields(fields: FileMetadataFields): Uint8Array<ArrayBuffer> {
	const path = new TextEncoder().encode(fields.path);
	// UTF-8 has no form for a lone surrogate: encoding would replace it, so another
	// device would open the file under a different name.
	if (!path.length || utf8.decode(path) !== fields.path) throw new Error('This file name is not valid Unicode, so it cannot be encrypted');
	const bytes = new Uint8Array(FIXED + path.length);
	bytes.set(hexBytes(fields.hash), 0);
	bytes.set(hexBytes(fields.publicDataHash), HASH);
	new DataView(bytes.buffer).setUint32(HASH * 2, fields.size);
	bytes.set(path, FIXED);
	return bytes;
}

function decodeFields(bytes: Uint8Array<ArrayBuffer>): FileMetadataFields {
	if (bytes.length <= FIXED) throw new Error('Invalid encrypted file metadata');
	return { hash: bytesHex(bytes.subarray(0, HASH)), publicDataHash: bytesHex(bytes.subarray(HASH, HASH * 2)),
		size: new DataView(bytes.buffer, bytes.byteOffset).getUint32(HASH * 2), path: utf8.decode(bytes.subarray(FIXED)) };
}

export async function sealFileMetadata(fields: FileMetadataFields, key: EncryptionKey, ids: FileMetadataIds): Promise<string> {
	const plaintext = encodeFields(fields), aad = additionalData(ids);
	if (WRAPPED_KEY + IV + plaintext.length + TAG > MAX_FILE_METADATA_ENVELOPE_BYTES) throw new Error('Encrypted file metadata is too large');
	const contentKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
	const wrapped = new Uint8Array(await crypto.subtle.wrapKey('raw', contentKey, key.key, 'AES-KW'));
	const iv = crypto.getRandomValues(new Uint8Array(IV));
	const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, contentKey, plaintext));
	const envelope = new Uint8Array(WRAPPED_KEY + IV + sealed.length);
	envelope.set(wrapped, 0);
	envelope.set(iv, WRAPPED_KEY);
	envelope.set(sealed, WRAPPED_KEY + IV);
	return encodeBase64Url(envelope);
}

/** Callers must validate the returned fields. */
export async function openFileMetadataEnvelope(envelope: string, key: EncryptionKey, ids: FileMetadataIds): Promise<FileMetadataFields> {
	const aad = additionalData(ids);
	const bytes = decodeBase64Url(envelope, MAX_FILE_METADATA_ENVELOPE_BYTES);
	if (bytes.length < MIN_FILE_METADATA_ENVELOPE_BYTES) throw new Error('Invalid encrypted file metadata');
	let plaintext: Uint8Array<ArrayBuffer>;
	try {
		const contentKey = await crypto.subtle.unwrapKey('raw', bytes.subarray(0, WRAPPED_KEY), key.key, 'AES-KW', 'AES-GCM', false, ['decrypt']);
		plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(WRAPPED_KEY, WRAPPED_KEY + IV), additionalData: aad },
			contentKey, bytes.subarray(WRAPPED_KEY + IV)));
	} catch {
		throw new Error('Encrypted data belongs to another vault, scope, object, or key version');
	}
	return decodeFields(plaintext);
}

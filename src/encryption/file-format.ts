import { isEncryptionId } from './encoding';

export const ENCRYPTED_FILE_CONTENT_TYPE = 'application/vnd.crate.encrypted-file';
const ENCRYPTED_FILE_PREFIX = 'CRATE-E2EE/1\n';
export const MAX_ENCRYPTED_FILE_BYTES = 38 * 1024 * 1024;
export const MAX_ENCRYPTED_PUBLIC_DATA_BYTES = 2 * 1024 * 1024;

/** This descriptor contains no plaintext content digest or decryption key. */
export interface EncryptedFileDescriptor {
	version: 1;
	vaultId: string;
	scopeId: string;
	objectId: string;
	keyId: string;
	metadata: string;
}

export interface EncryptedFilePacket {
	descriptor: EncryptedFileDescriptor;
	ciphertext: string;
	publicData: unknown;
}

export function validateFileDescriptor(value: unknown): asserts value is EncryptedFileDescriptor {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid encrypted file descriptor');
	const item = value as Partial<EncryptedFileDescriptor>;
	if (Object.keys(item).some(key => !['version', 'vaultId', 'scopeId', 'objectId', 'keyId', 'metadata'].includes(key))) throw new Error('Unexpected encrypted file descriptor field');
	if (item.version !== 1 || ![item.vaultId, item.scopeId, item.objectId, item.keyId].every(isEncryptionId)
		|| typeof item.metadata !== 'string' || item.metadata.length > 8192 || item.metadata.split('.').length !== 5) {
		throw new Error('Unsupported or damaged encrypted file descriptor');
	}
}

export function encodeEncryptedFile(packet: EncryptedFilePacket): Uint8Array<ArrayBuffer> {
	validateFileDescriptor(packet.descriptor);
	validatePublicData(packet.publicData);
	const bytes = new TextEncoder().encode(ENCRYPTED_FILE_PREFIX
		+ JSON.stringify({ descriptor: packet.descriptor, publicData: packet.publicData }) + '\n' + packet.ciphertext);
	if (bytes.length > MAX_ENCRYPTED_FILE_BYTES) throw new Error('Encrypted file exceeds its transport limit');
	return bytes;
}

export function isEncryptedFile(bytes: Uint8Array | string): boolean {
	if (typeof bytes === 'string') return bytes.startsWith('CRATE-E2EE/');
	return bytes.length >= 11 && bytes[0] === 67 && bytes[1] === 82 && bytes[2] === 65
		&& bytes[3] === 84 && bytes[4] === 69 && bytes[5] === 45 && bytes[6] === 69
		&& bytes[7] === 50 && bytes[8] === 69 && bytes[9] === 69 && bytes[10] === 47;
}

/** Server-side parsing validates framing only. It cannot establish that a
 * client's scheduling projection describes its encrypted Markdown correctly. */
export function parseEncryptedFile(bytes: Uint8Array | string): EncryptedFilePacket {
	if ((typeof bytes === 'string' ? bytes.length : bytes.byteLength) > MAX_ENCRYPTED_FILE_BYTES) throw new Error('Encrypted file exceeds its transport limit');
	const text = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	if (!text.startsWith(ENCRYPTED_FILE_PREFIX)) throw new Error('Unsupported encrypted file format');
	// Keep the large opaque ciphertext out of JSON.parse. The Worker can inspect
	// a bounded header without allocating a second full ciphertext string.
	const headerEnd = text.indexOf('\n', ENCRYPTED_FILE_PREFIX.length);
	if (headerEnd < 0 || headerEnd > MAX_ENCRYPTED_PUBLIC_DATA_BYTES + 16 * 1024) throw new Error('Invalid encrypted file header');
	const packet: unknown = JSON.parse(text.slice(ENCRYPTED_FILE_PREFIX.length, headerEnd));
	if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw new Error('Invalid encrypted file');
	const value = packet as Partial<EncryptedFilePacket>;
	if (Object.keys(value).some(key => key !== 'descriptor' && key !== 'publicData')) throw new Error('Unexpected encrypted file header');
	validateFileDescriptor(value.descriptor);
	const ciphertext = text.slice(headerEnd + 1);
	if (ciphertext.split('.').length !== 5) throw new Error('Invalid encrypted file content');
	validatePublicData(value.publicData);
	return { descriptor: value.descriptor, ciphertext, publicData: value.publicData };
}

export function fileTransportLimit(contentType: string | undefined): number {
	return contentType === ENCRYPTED_FILE_CONTENT_TYPE ? MAX_ENCRYPTED_FILE_BYTES : 25 * 1024 * 1024;
}

function validatePublicData(value: unknown): void {
	const json = JSON.stringify(value);
	if (json === undefined || new TextEncoder().encode(json).byteLength > MAX_ENCRYPTED_PUBLIC_DATA_BYTES) {
		throw new Error('Invalid encrypted file scheduling metadata');
	}
}

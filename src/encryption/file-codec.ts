import { decryptBytes, decryptJson, encryptBytes, encryptJson, type EncryptionContext, type EncryptionKey } from './envelope';
import { encodeEncryptedFile, parseEncryptedFile, validateFileDescriptor, type EncryptedFileDescriptor } from './file-format';

export interface PrivateFileMetadata {
	version: 1;
	path: string;
	hash: string;
	size: number;
	contentType: string;
	publicDataHash: string;
}

export interface FileEncryptionAuthority {
	vaultId: string;
	scopeId: string;
	key: EncryptionKey;
}

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

function context(descriptor: EncryptedFileDescriptor, purpose: EncryptionContext['purpose']): EncryptionContext {
	return { vaultId: descriptor.vaultId, scopeId: descriptor.scopeId, objectId: descriptor.objectId, purpose };
}

function validateAuthority(descriptor: EncryptedFileDescriptor, authority: FileEncryptionAuthority): void {
	validateFileDescriptor(descriptor);
	if (descriptor.vaultId !== authority.vaultId || descriptor.scopeId !== authority.scopeId || descriptor.keyId !== authority.key.id) {
		throw new Error('File encryption keys belong to another vault or scope');
	}
}

function validateMetadata(value: unknown, expectedPath: string): asserts value is PrivateFileMetadata {
	if (!value || typeof value !== 'object') throw new Error('Invalid encrypted file metadata');
	const item = value as Partial<PrivateFileMetadata>;
	if (item.version !== 1 || item.path !== expectedPath || typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash)
		|| typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 25 * 1024 * 1024
		|| typeof item.contentType !== 'string' || item.contentType.length > 256
		|| typeof item.publicDataHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.publicDataHash)) {
		throw new Error('Encrypted file metadata does not match the requested file');
	}
}

/** Persist these exact returned bytes before dispatching a mutating request. */
export async function sealFile(input: {
	path: string;
	content: Uint8Array<ArrayBuffer>;
	contentType: string;
	publicData?: unknown;
}, authority: FileEncryptionAuthority): Promise<{ bytes: Uint8Array<ArrayBuffer>; descriptor: EncryptedFileDescriptor; metadata: PrivateFileMetadata; hash: string }> {
	const publicData = input.publicData ?? null;
	const metadata: PrivateFileMetadata = { version: 1, path: input.path, hash: await digest(input.content),
		size: input.content.byteLength, contentType: input.contentType,
		publicDataHash: await digest(new TextEncoder().encode(JSON.stringify(publicData))) };
	validateMetadata(metadata, input.path);
	const descriptor: EncryptedFileDescriptor = { version: 1, vaultId: authority.vaultId, scopeId: authority.scopeId,
		objectId: crypto.randomUUID(), keyId: authority.key.id, metadata: '' };
	descriptor.metadata = await encryptJson(metadata, authority.key, context(descriptor, 'file-metadata'));
	const ciphertext = await encryptBytes(input.content, authority.key, context(descriptor, 'file'));
	const bytes = encodeEncryptedFile({ descriptor, ciphertext, publicData });
	return { bytes, descriptor, metadata, hash: await digest(bytes) };
}

export async function openFileMetadata(descriptor: EncryptedFileDescriptor, expectedPath: string, authority: FileEncryptionAuthority): Promise<PrivateFileMetadata> {
	validateAuthority(descriptor, authority);
	const metadata = await decryptJson(descriptor.metadata, authority.key, context(descriptor, 'file-metadata'));
	validateMetadata(metadata, expectedPath);
	return metadata;
}

export async function openFile(bytes: Uint8Array<ArrayBuffer>, expectedPath: string, authority: FileEncryptionAuthority): Promise<{
	content: Uint8Array<ArrayBuffer>;
	metadata: PrivateFileMetadata;
	publicData: unknown;
}> {
	const packet = parseEncryptedFile(bytes);
	const metadata = await openFileMetadata(packet.descriptor, expectedPath, authority);
	if (await digest(new TextEncoder().encode(JSON.stringify(packet.publicData))) !== metadata.publicDataHash) {
		throw new Error('Encrypted file scheduling metadata failed authentication');
	}
	const content = await decryptBytes(packet.ciphertext, authority.key, context(packet.descriptor, 'file'));
	if (content.byteLength !== metadata.size || await digest(content) !== metadata.hash) throw new Error('Encrypted file failed content verification');
	return { content, metadata, publicData: packet.publicData };
}

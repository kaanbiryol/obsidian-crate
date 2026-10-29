import { decryptBytes, decryptJson, encryptBytes, encryptJson, type EncryptionContext, type EncryptionKey } from './envelope';
import { encodeEncryptedFile, parseEncryptedFile, validateFileDescriptor, type EncryptedFileDescriptor } from './file-format';
import { sha256Hex } from '../platform/sha256';
import { openSealedFileKey, type SealOpenKey } from './sealed-file-key';
import { isSha256Hex } from '../platform/validation';

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
	/** Present only where this client accepts files the server sealed to the vault. */
	seal?: SealOpenKey;
}

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	return sha256Hex(bytes);
}

function context(descriptor: EncryptedFileDescriptor, purpose: EncryptionContext['purpose']): EncryptionContext {
	return { vaultId: descriptor.vaultId, scopeId: descriptor.scopeId, objectId: descriptor.objectId, purpose };
}

/** The key that opens this file: the vault key, or for a sealed file one derived
 * from the seal key. Sealing never reuses the vault key, and vice versa. */
async function fileKey(descriptor: EncryptedFileDescriptor, authority: FileEncryptionAuthority): Promise<EncryptionKey> {
	validateFileDescriptor(descriptor);
	if (descriptor.vaultId !== authority.vaultId || descriptor.scopeId !== authority.scopeId) throw new Error('File encryption keys belong to another vault or scope');
	if (!descriptor.seal) {
		if (descriptor.keyId !== authority.key.id) throw new Error('File encryption keys belong to another vault or scope');
		return authority.key;
	}
	if (!authority.seal || descriptor.keyId !== authority.seal.keyId) throw new Error('This file was created by the server and is not accepted here');
	return openSealedFileKey({ ...descriptor, seal: descriptor.seal }, authority.seal);
}

/** How a reader checks the path a file claims: an exact path, or a check that compares
 * it with where the file is stored and returns the plaintext path. `hash` is the
 * authenticated plaintext hash. */
export type PathBinding = string | ((metadataPath: string, sealed: boolean, hash: string) => Promise<string>);

function validateMetadata(value: unknown): asserts value is PrivateFileMetadata {
	if (!value || typeof value !== 'object') throw new Error('Invalid encrypted file metadata');
	const item = value as Partial<PrivateFileMetadata>;
	if (item.version !== 1 || typeof item.path !== 'string' || !item.path || item.path.length > 4096 || !isSha256Hex(item.hash)
		|| typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 25 * 1024 * 1024
		|| typeof item.contentType !== 'string' || item.contentType.length > 256
		|| !isSha256Hex(item.publicDataHash)) {
		throw new Error('Encrypted file metadata does not match the requested file');
	}
}

type FileInput = { path: string; content: Uint8Array<ArrayBuffer>; contentType: string; publicData?: unknown };
type SealedFile = { bytes: Uint8Array<ArrayBuffer>; descriptor: EncryptedFileDescriptor; metadata: PrivateFileMetadata; hash: string };

/** Persist these exact returned bytes before dispatching a mutating request. */
export async function sealFile(input: FileInput, authority: FileEncryptionAuthority): Promise<SealedFile> {
	return sealFileWithHeader(input, { version: 1, vaultId: authority.vaultId, scopeId: authority.scopeId,
		objectId: crypto.randomUUID(), keyId: authority.key.id }, authority.key);
}

/** Shared by vault-key files and files the server seals to the vault. */
export async function sealFileWithHeader(input: FileInput, header: Omit<EncryptedFileDescriptor, 'metadata'>, key: EncryptionKey): Promise<SealedFile> {
	const publicData = input.publicData ?? null;
	const metadata: PrivateFileMetadata = { version: 1, path: input.path, hash: await digest(input.content),
		size: input.content.byteLength, contentType: input.contentType,
		publicDataHash: await digest(new TextEncoder().encode(JSON.stringify(publicData))) };
	validateMetadata(metadata);
	const descriptor: EncryptedFileDescriptor = { ...header, metadata: '' };
	descriptor.metadata = await encryptJson(metadata, key, context(descriptor, 'file-metadata'));
	const ciphertext = await encryptBytes(input.content, key, context(descriptor, 'file'));
	const bytes = encodeEncryptedFile({ descriptor, ciphertext, publicData });
	return { bytes, descriptor, metadata, hash: await digest(bytes) };
}

/** The returned metadata carries the plaintext path the binding accepted. */
export async function openFileMetadata(descriptor: EncryptedFileDescriptor, binding: PathBinding, authority: FileEncryptionAuthority): Promise<PrivateFileMetadata> {
	return (await openMetadataWithKey(descriptor, binding, authority)).metadata;
}

async function openMetadataWithKey(descriptor: EncryptedFileDescriptor, binding: PathBinding, authority: FileEncryptionAuthority) {
	const key = await fileKey(descriptor, authority);
	const metadata = await decryptJson(descriptor.metadata, key, context(descriptor, 'file-metadata'));
	validateMetadata(metadata);
	const path = typeof binding === 'string' ? metadata.path === binding ? binding : null : await binding(metadata.path, !!descriptor.seal, metadata.hash);
	if (path === null) throw new Error('Encrypted file metadata does not match the requested file');
	return { metadata: { ...metadata, path }, key };
}

export async function openFile(bytes: Uint8Array<ArrayBuffer>, binding: PathBinding, authority: FileEncryptionAuthority): Promise<{
	content: Uint8Array<ArrayBuffer>;
	metadata: PrivateFileMetadata;
	publicData: unknown;
}> {
	const packet = parseEncryptedFile(bytes);
	const { metadata, key } = await openMetadataWithKey(packet.descriptor, binding, authority);
	if (await digest(new TextEncoder().encode(JSON.stringify(packet.publicData))) !== metadata.publicDataHash) {
		throw new Error('Encrypted file scheduling metadata failed authentication');
	}
	const content = await decryptBytes(packet.ciphertext, key, context(packet.descriptor, 'file'));
	if (content.byteLength !== metadata.size || await digest(content) !== metadata.hash) throw new Error('Encrypted file failed content verification');
	return { content, metadata, publicData: packet.publicData };
}

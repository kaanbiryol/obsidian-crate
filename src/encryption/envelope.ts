import { CompactEncrypt } from 'jose/jwe/compact/encrypt';
import { compactDecrypt } from 'jose/jwe/compact/decrypt';
import { decodeProtectedHeader } from 'jose/decode/protected_header';
import { decodeBase64Url, encodeBase64Url, isEncryptionId, validateBase64Url } from './encoding';

const ENCRYPTION_VERSION = 1;
const MAX_ENCRYPTED_PLAINTEXT_BYTES = 25 * 1024 * 1024;
const MAX_ENVELOPE_CHARACTERS = Math.ceil(MAX_ENCRYPTED_PLAINTEXT_BYTES * 4 / 3) + 4096;
const TYPE = 'crate-e2ee+jwe';

type EncryptionPurpose = 'file' | 'file-metadata' | 'settings' | 'reminder' | 'notification' | 'local-state' | 'key-bundle';
export interface EncryptionContext {
	vaultId: string;
	scopeId: string;
	objectId: string;
	purpose: EncryptionPurpose;
}

/** Secret material is confined to clients, their protected storage, and recovery exports. */
export interface EncryptionSecret {
	id: string;
	secret: string;
}
export interface EncryptionKey {
	id: string;
	key: CryptoKey;
}

export function generateEncryptionSecret(): EncryptionSecret {
	return { id: crypto.randomUUID(), secret: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))) };
}

export async function importEncryptionSecret(secret: EncryptionSecret): Promise<EncryptionKey> {
	if (!isEncryptionId(secret.id) || typeof secret.secret !== 'string') throw new Error('Invalid encryption key');
	const raw = decodeBase64Url(secret.secret, 32);
	if (raw.length !== 32) throw new Error('Invalid encryption key');
	try {
		return { id: secret.id, key: await crypto.subtle.importKey('raw', raw, 'AES-KW', false, ['wrapKey', 'unwrapKey']) };
	} finally { raw.fill(0); }
}

function protectedHeader(context: EncryptionContext, keyId: string) {
	if (![context.vaultId, context.scopeId, context.objectId, keyId].every(isEncryptionId)
		|| !['file', 'file-metadata', 'settings', 'reminder', 'notification', 'local-state', 'key-bundle'].includes(context.purpose)) {
		throw new Error('Invalid encryption context');
	}
	return { alg: 'A256KW', enc: 'A256GCM', typ: TYPE, v: ENCRYPTION_VERSION, kid: keyId,
		vault: context.vaultId, scope: context.scopeId, object: context.objectId, purpose: context.purpose };
}

/** JWE generates a fresh content-encryption key for every envelope, wrapped by the
 * scope key. Different devices never share a GCM content key/nonce sequence. */
export async function encryptBytes(bytes: Uint8Array, key: EncryptionKey, context: EncryptionContext): Promise<string> {
	if (bytes.byteLength > MAX_ENCRYPTED_PLAINTEXT_BYTES) throw new Error('Content exceeds the encryption size limit');
	return new CompactEncrypt(bytes).setProtectedHeader(protectedHeader(context, key.id)).encrypt(key.key);
}

export async function decryptBytes(envelope: string, key: EncryptionKey, context: EncryptionContext): Promise<Uint8Array<ArrayBuffer>> {
	if (typeof envelope !== 'string' || envelope.length > MAX_ENVELOPE_CHARACTERS) throw new Error('Invalid encrypted envelope');
	const segments = envelope.split('.');
	if (segments.length !== 5 || !segments[0] || segments[0].length > 2048) throw new Error('Invalid encrypted envelope');
	const expected = protectedHeader(context, key.id);
	const header = decodeProtectedHeader(envelope);
	if (Object.keys(header).length !== Object.keys(expected).length
		|| Object.entries(expected).some(([name, value]) => header[name] !== value)) {
		throw new Error('Encrypted data belongs to another vault, scope, object, or key version');
	}
	// Reject alternate encodings before JOSE verification so envelopes have one
	// byte representation for durable request hashes and receipt retries.
	const limits = [1536, 40, 12, MAX_ENCRYPTED_PLAINTEXT_BYTES, 16];
	for (let index = 0; index < segments.length; index++) {
		const length = validateBase64Url(segments[index]!, limits[index]!);
		if ([1, 2, 4].includes(index) && length !== limits[index]) throw new Error('Invalid encrypted envelope');
	}
	const { plaintext } = await compactDecrypt(envelope, key.key, {
		keyManagementAlgorithms: ['A256KW'], contentEncryptionAlgorithms: ['A256GCM'],
	});
	return new Uint8Array(plaintext);
}

export async function encryptJson(value: unknown, key: EncryptionKey, context: EncryptionContext): Promise<string> {
	const json = JSON.stringify(value);
	if (json === undefined) throw new Error('Value cannot be encrypted as JSON');
	return encryptBytes(new TextEncoder().encode(json), key, context);
}

/** Callers must validate the decrypted application record before using it. */
export async function decryptJson(envelope: string, key: EncryptionKey, context: EncryptionContext): Promise<unknown> {
	return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await decryptBytes(envelope, key, context))) as unknown;
}

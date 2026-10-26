import type { EncryptionKey } from './envelope';
import { deriveP256Secret } from './p256';

/** The vault seal key's private half, held only by unlocked clients. */
export interface SealOpenKey { keyId: string; publicKey: string; privateKey: CryptoKey }

interface SealBinding { vaultId: string; objectId: string; keyId: string; epk: string; recipient: string }

/** One wrapping key per sealed file: ECDH between a fresh ephemeral key and the
 * vault seal key, bound to the file identity so it cannot be reused elsewhere. */
export async function sealedFileKey(secret: Uint8Array<ArrayBuffer>, binding: SealBinding): Promise<EncryptionKey> {
	try {
		const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
		const salt = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(
			['crate-e2ee-seal-v1', binding.vaultId, binding.objectId, binding.keyId, binding.epk, binding.recipient])));
		const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('crate-e2ee-v1/sealed-file-key') },
			material, { name: 'AES-KW', length: 256 }, false, ['wrapKey', 'unwrapKey']);
		return { id: binding.keyId, key };
	} finally { secret.fill(0); }
}

export async function openSealedFileKey(descriptor: { vaultId: string; objectId: string; keyId: string; seal: { epk: string } }, seal: SealOpenKey): Promise<EncryptionKey> {
	return sealedFileKey(await deriveP256Secret(seal.privateKey, descriptor.seal.epk),
		{ vaultId: descriptor.vaultId, objectId: descriptor.objectId, keyId: descriptor.keyId, epk: descriptor.seal.epk, recipient: seal.publicKey });
}

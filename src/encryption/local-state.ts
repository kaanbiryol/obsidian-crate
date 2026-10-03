import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { decodeBase64Url, encodeBase64Url, isEncryptionId } from './encoding';

const PREFIX = 'crate-local-e2ee-v1.';
const LIMIT = 16 * 1024 * 1024;

/** Synchronous protection preserves Web Storage's write-before-dispatch contract.
 * The independent local key is wrapped with the folder key when persisted.
 * XChaCha's random 192-bit nonces permit independent tabs to write safely. */
export class LocalStateCipher {
	private secret: Uint8Array<ArrayBuffer>;
	constructor(readonly vaultId: string, readonly scopeId: string, secret: Uint8Array<ArrayBuffer>) {
		if (!isEncryptionId(vaultId) || !isEncryptionId(scopeId) || secret.length !== 32) throw new Error('Invalid local encryption key');
		this.secret = secret.slice();
	}
	seal(value: string, storageKey: string): string {
		const content = new TextEncoder().encode(value);
		if (content.length > LIMIT) throw new Error('Private browser data exceeds its storage limit');
		const nonce = crypto.getRandomValues(new Uint8Array(24));
		const ciphertext = xchacha20poly1305(this.secret, nonce, this.context(storageKey)).encrypt(content);
		return PREFIX + encodeBase64Url(nonce) + '.' + encodeBase64Url(ciphertext);
	}
	open(value: string, storageKey: string): string {
		if (!value.startsWith(PREFIX)) throw new Error('Unsupported or unencrypted browser data. Preserve it before recovery.');
		const parts = value.slice(PREFIX.length).split('.');
		if (parts.length !== 2) throw new Error('Damaged encrypted browser data');
		const nonce = decodeBase64Url(parts[0]!, 24);
		if (nonce.length !== 24) throw new Error('Damaged encrypted browser data');
		const plaintext = xchacha20poly1305(this.secret, nonce, this.context(storageKey)).decrypt(decodeBase64Url(parts[1]!, LIMIT + 16));
		try { return new TextDecoder('utf-8', { fatal: true }).decode(plaintext); }
		finally { plaintext.fill(0); }
	}
	destroy(): void { this.secret.fill(0); this.secret = new Uint8Array(0); }
	private context(storageKey: string): Uint8Array<ArrayBuffer> {
		if (this.secret.length !== 32) throw new Error('Encryption keys are locked');
		return new TextEncoder().encode(JSON.stringify(['crate-local-e2ee', 1, this.vaultId, this.scopeId, storageKey]));
	}
}

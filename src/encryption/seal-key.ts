import { decodeBase64Url, encodeBase64Url, isEncryptionId } from './encoding';
import { P256, validateP256PublicKey } from './p256';

/** Lets the server create Reading notes for the vault without being able to read them.
 * The public half is stored on the server; the private half only in the key bundle. */
export interface SealKeyPair {
  id: string;
  /** Uncompressed P-256 point, base64url. */
  publicKey: string;
  /** The 32-byte private scalar, base64url. */
  privateKey: string;
}

export async function generateSealKeyPair(): Promise<SealKeyPair> {
  const pair = await crypto.subtle.generateKey(P256, true, ['deriveBits']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { id: crypto.randomUUID(), publicKey: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))), privateKey: jwk.d! };
}

export function validateSealKeyPair(value: unknown): asserts value is SealKeyPair {
  const pair = value as Partial<SealKeyPair> | null;
  if (!pair || typeof pair !== 'object' || Object.keys(pair).some(key => !['id', 'publicKey', 'privateKey'].includes(key))
    || !isEncryptionId(pair.id) || typeof pair.privateKey !== 'string' || decodeBase64Url(pair.privateKey, 32).length !== 32) throw new Error('Invalid seal key');
  validateP256PublicKey(pair.publicKey);
}

/** Import for ECDH only; the private key never leaves WebCrypto once imported. */
export async function importSealPrivateKey(pair: Pick<SealKeyPair, 'publicKey' | 'privateKey'>): Promise<CryptoKey> {
  const point = decodeBase64Url(pair.publicKey, 65);
  return crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: encodeBase64Url(point.slice(1, 33)), y: encodeBase64Url(point.slice(33)), d: pair.privateKey, ext: false },
    P256, false, ['deriveBits']);
}

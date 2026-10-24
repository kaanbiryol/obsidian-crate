import { decodeBase64Url, encodeBase64Url } from './encoding';

export const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** An uncompressed P-256 point, base64url encoded. */
export function validateP256PublicKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || decodeBase64Url(value, 65).length !== 65 || decodeBase64Url(value, 65)[0] !== 4) throw new Error('Invalid public key.');
}

export async function generateEphemeralP256(): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const pair = await crypto.subtle.generateKey(P256, false, ['deriveBits']);
  return { privateKey: pair.privateKey, publicKey: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))) };
}

/** The raw ECDH secret. Callers derive keys from it and then zero it. */
export async function deriveP256Secret(privateKey: CryptoKey, peer: string): Promise<Uint8Array<ArrayBuffer>> {
  validateP256PublicKey(peer);
  const publicKey = await crypto.subtle.importKey('raw', decodeBase64Url(peer, 65), P256, false, []);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256));
}

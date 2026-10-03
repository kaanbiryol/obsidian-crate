import { decodeBase64Url, encodeBase64Url, isEncryptionId } from '../encoding';

export const PAIRING_CAPABILITY = 'web-pairing-v1';
export const PAIRING_PATH = '/encryption/pairing';
export const PAIRING_LIFETIME = 5 * 60_000;
export class PairingEndedError extends Error {}
export interface PairingContext {
  version: 1; id: string; origin: string; vaultId: string; generation: number; scopeId: string;
}
export interface PairingRequest { context: PairingContext; commitment: string }
export interface PairingRecord extends PairingRequest {
  expiresAt: number; responderKey?: string; requesterKey?: string; payload?: string; closed?: boolean;
}
export interface PairingTransport {
  read(id?: string): Promise<{ requests: PairingRecord[] }>;
  write(body: Record<string, unknown>): Promise<{ request: PairingRecord }>;
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const contextValues = (c: PairingContext) => [c.version, c.id, c.origin, c.vaultId, c.generation, c.scopeId];

export function validatePairingContext(value: unknown): asserts value is PairingContext {
  const c = value as Partial<PairingContext> | null;
  if (!c || c.version !== 1 || !isEncryptionId(c.id) || !isEncryptionId(c.vaultId) || !isEncryptionId(c.scopeId)
    || !Number.isSafeInteger(c.generation) || c.generation! < 1 || typeof c.origin !== 'string' || c.origin.length > 2048
    || !/^https?:\/\//.test(c.origin) || new URL(c.origin).origin !== c.origin) throw new Error('Invalid app pairing request.');
}
export function samePairingContext(a: PairingContext, b: PairingContext): boolean {
  return JSON.stringify(contextValues(a)) === JSON.stringify(contextValues(b));
}
export function validatePairingKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || decodeBase64Url(value, 65).length !== 65 || decodeBase64Url(value, 65)[0] !== 4) throw new Error('Invalid pairing public key.');
}
export function validatePairingRecord(value: unknown): asserts value is PairingRecord {
  const r = value as PairingRecord | null;
  validatePairingContext(r?.context);
  if (!r || typeof r.commitment !== 'string' || decodeBase64Url(r.commitment, 32).length !== 32
    || !Number.isSafeInteger(r.expiresAt)) throw new Error('Invalid app pairing response.');
  if (r.responderKey !== undefined) validatePairingKey(r.responderKey);
  if (r.requesterKey !== undefined) validatePairingKey(r.requesterKey);
  if (r.payload !== undefined && (typeof r.payload !== 'string' || decodeBase64Url(r.payload, 16384).length < 28)) throw new Error('Invalid pairing packet.');
  if (r.closed !== undefined && typeof r.closed !== 'boolean') throw new Error('Invalid pairing status.');
}
export function assertPairingCurrent(record: PairingRecord, expected: PairingRequest, deadline: number): void {
  validatePairingRecord(record);
  if (!samePairingContext(record.context, expected.context) || record.commitment !== expected.commitment
    || record.closed || record.expiresAt > deadline || record.expiresAt <= Date.now()) throw new PairingEndedError('This pairing ended or changed. Start again.');
}
const algorithm = { name: 'ECDH', namedCurve: 'P-256' };
async function ephemeral() {
  const pair = await crypto.subtle.generateKey(algorithm, false, ['deriveBits']);
  return { privateKey: pair.privateKey, publicKey: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))) };
}
export async function pairingCommitment(context: PairingContext, publicKey: string): Promise<string> {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(['crate-web-pairing-v1', ...contextValues(context), publicKey]))));
}

async function channel(privateKey: CryptoKey, peer: string, request: PairingRequest, requesterKey: string, responderKey: string) {
  validatePairingKey(peer);
  const publicKey = await crypto.subtle.importKey('raw', decodeBase64Url(peer, 65), algorithm, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256));
  const transcript = bytes(['crate-web-pairing-v1', ...contextValues(request.context), request.commitment, requesterKey, responderKey]);
  try {
    const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey', 'deriveBits']);
    const salt = await crypto.subtle.digest('SHA-256', transcript);
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: bytes('key-transfer') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const sas = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: bytes('verification-code') }, material, 40));
    // Three 13-bit decimal groups, with a commitment before either peer can
    // adapt its key to the other's. Codes are compared out of band by the user.
    const code = [((sas[0]! << 5) | (sas[1]! >> 3)), ((sas[1]! & 7) << 10) | (sas[2]! << 2) | (sas[3]! >> 6), ((sas[3]! & 63) << 7) | (sas[4]! >> 1)].map(n => String(n + 1000)).join(' ');
    return {
      code,
      async seal(value: unknown): Promise<string> {
        const plain = bytes(value);
        if (plain.length > 16000) throw new Error('Pairing packet is too large.');
        const iv = crypto.getRandomValues(new Uint8Array(12));
        try {
          const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: transcript }, key, plain));
          const packet = new Uint8Array(iv.length + cipher.length); packet.set(iv); packet.set(cipher, iv.length);
          return encodeBase64Url(packet);
        } finally { plain.fill(0); }
      },
      async open(packet: string): Promise<unknown> {
        const cipher = decodeBase64Url(packet, 16384);
        const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: cipher.slice(0, 12), additionalData: transcript }, key, cipher.slice(12)));
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)) as unknown; }
        finally { plain.fill(0); }
      },
    };
  } finally { secret.fill(0); }
}
/** The requester commits before the responder sees its public key. Pin the
 * responder before revealing; never reuse an attempt with another responder. */
export async function createPairingRequester(context: PairingContext) {
  validatePairingContext(context);
  const keys = await ephemeral();
  const request = { context, commitment: await pairingCommitment(context, keys.publicKey) };
  let pinned: string | undefined;
  return { request, async accept(responderKey: string) {
    if (pinned && pinned !== responderKey) throw new Error('Pairing device changed. Start again.');
    pinned = responderKey;
    const agreed = await channel(keys.privateKey, responderKey, request, keys.publicKey, responderKey);
    return { ...agreed, publicKey: keys.publicKey };
  } };
}
export async function createPairingResponder(request: PairingRequest) {
  validatePairingContext(request.context);
  const keys = await ephemeral();
  let pinned: string | undefined;
  return { publicKey: keys.publicKey, async accept(requesterKey: string) {
    if (pinned && pinned !== requesterKey || await pairingCommitment(request.context, requesterKey) !== request.commitment) throw new Error('Pairing verification failed. Start again.');
    pinned = requesterKey;
    return channel(keys.privateKey, requesterKey, request, requesterKey, keys.publicKey);
  } };
}

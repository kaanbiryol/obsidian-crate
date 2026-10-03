import type { LocalStateCipher } from '@/encryption/local-state';
let cipher: LocalStateCipher | undefined;
let required = false;
let lockReason: string | undefined;
export function lockReadingStorage(encrypted = true, reason?: string): void { cipher?.destroy(); cipher = undefined; required = encrypted; lockReason = reason; }
export function unlockReadingStorage(value: LocalStateCipher): void { cipher?.destroy(); cipher = value; required = true; lockReason = undefined; }
export function encodeReadingValue(key: string, value: unknown): unknown {
  if (required && !cipher) throw new Error(lockReason ?? 'Unlock Reading before saving private data.');
  return cipher ? { encryptedReading: 1, content: cipher.seal(JSON.stringify(value), key) } : value;
}
export function decodeReadingValue(key: string, value: unknown): unknown {
  if (value === undefined) return value;
  if (value && typeof value === 'object' && 'encryptedReading' in value) {
    if (value.encryptedReading !== 1) throw new Error('Saved Reading data uses an unsupported encryption format. Update Crate before opening it.');
    if (!cipher || !('content' in value) || typeof value.content !== 'string') throw new Error('Unlock Reading to open saved private data.');
    return JSON.parse(cipher.open(value.content, key)) as unknown;
  }
  if (required) throw new Error(lockReason ?? 'Private Reading storage needs migration before opening.');
  return value;
}

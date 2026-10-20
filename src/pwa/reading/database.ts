import type { IDBPDatabase, DBSchema } from 'idb';
import { openSingleStoreDatabase } from '../storage/single-store-database';
import { encodeReadingValue, decodeReadingValue } from './private-storage';
import { assertReadingSession, type ReadingSession } from './session';

interface ReadingDatabase extends DBSchema { values: { key: string; value: unknown } }
let opening: Promise<IDBPDatabase<ReadingDatabase>> | undefined;
/** Shared database lifetime for caches, durable changes, and encryption migration. */
export function readingDatabase(): Promise<IDBPDatabase<ReadingDatabase>> {
  if (opening) return opening;
  const request = openSingleStoreDatabase<ReadingDatabase>('crate-reading-v1', 'values', {
    messages: {
      blocked: 'Reading storage is blocked. Close other Crate tabs and retry.',
      unsupported: 'Reading storage uses an unsupported format. Update Crate before retrying.',
      unavailable: 'Reading storage is unavailable. Check browser storage permissions and retry.',
    },
    onClose: () => { if (opening === request) opening = undefined; },
  });
  opening = request;
  void request.catch(() => { if (opening === request) opening = undefined; });
  return request;
}
/** Storage internals retain raw keys so exports can preserve unknown records. */
export async function readReadingValue(key: string): Promise<unknown> {
  const db = await readingDatabase();
  const value = decodeReadingValue(key, await db.get('values', key));
  if (value && typeof value === 'object' && 'encryptedShare' in value) {
    const record = value as { encryptedShare: unknown; iv?: unknown; ciphertext?: unknown };
    if (record.encryptedShare !== 1 || !Array.isArray(record.iv) || record.iv.length !== 12 || !Array.isArray(record.ciphertext) || record.ciphertext.length > 32768
      || ![record.iv, record.ciphertext].every((bytes: unknown[]) => bytes.every(byte => typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255))) throw new Error('This shared link needs recovery.');
    const secret = await db.get('values', 'share-key') as CryptoKey | undefined;
    if (!secret) throw new Error('This shared link’s device key is unavailable.');
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(record.iv), additionalData: new TextEncoder().encode(key) }, secret, new Uint8Array(record.ciphertext));
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  }
  return value;
}

export async function writeReadingValue(key: string, value: unknown, session: ReadingSession): Promise<void> {
  const db = await readingDatabase();
  assertReadingSession(session);
  if (value === null) await db.delete('values', key); else await db.put('values', encodeReadingValue(key, value), key);
}

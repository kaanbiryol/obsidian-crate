import { decodeReadingValue } from './private-storage';
import type { PendingReading } from '../outbox';
import { isPendingReading, isReadingDraft } from './storage-validation';
import { downloadJson } from '../../storage/download';
import { abortTransaction } from '../../storage/abort-transaction';
import { readingDatabase, readReadingValue, writeReadingValue } from './database';
import { assertReadingSession, READING_CHANGED_EVENT, READING_SESSION_KEY, type ReadingSession } from '../session/session';
import { readingKeys, isPendingReadingKey } from './storage-keys';
import { exportWrappedLocalKeys } from '../../encryption/encryption-keys';

export { readReadingCache, readReadingArticle, commitReadingCache, cacheReadingArticle, readEncryptedReadingIndex, writeEncryptedReadingIndex, type ReadingCache } from './cache';

// Feature callers use these scoped operations; database keys remain inside storage.
interface ReadingDraft { url: string }
interface ReadingAttempt { requestHash: string; body: string; generation?: number; rejected?: true }

async function readDraft(key: string): Promise<ReadingDraft | undefined> {
  const value = await readReadingValue(key);
  if (value === undefined) return undefined;
  if (!isReadingDraft(value)) throw new Error('The saved Reading draft could not be read. Export your Reading data before changing browser storage.');
  return value;
}

export function readReadingDraft(session: ReadingSession): Promise<ReadingDraft | undefined> {
  return readDraft(readingKeys.draft(session.id));
}
export function saveReadingDraft(session: ReadingSession, draft: ReadingDraft): Promise<void> {
  return writeReadingValue(readingKeys.draft(session.id), draft, session);
}
export function readReadingShare(id: string): Promise<ReadingDraft | undefined> {
  return readDraft(readingKeys.share(id));
}
export function removeReadingShare(session: ReadingSession, id: string): Promise<void> {
  return writeReadingValue(readingKeys.share(id), null, session);
}
export function savePendingReading(session: ReadingSession, pending: PendingReading[]): Promise<void> {
  return writeReadingValue(readingKeys.pending(session.id), pending, session);
}
export function readReadingAttempt(session: ReadingSession, id: string): Promise<unknown> {
  return readReadingValue(`${readingKeys.attemptPrefix(session.id)}${id}`);
}
export function writeReadingAttempt(session: ReadingSession, id: string, attempt: ReadingAttempt): Promise<void> {
  return writeReadingValue(`${readingKeys.attemptPrefix(session.id)}${id}`, attempt, session);
}

export async function hasEarlierReadingChanges(sessionId?: string): Promise<boolean> {
  const db = await readingDatabase();
  for (const key of await db.getAllKeys('values')) {
    if (!isPendingReadingKey(key) || (sessionId !== undefined && key === readingKeys.pending(sessionId))) continue;
    let value: unknown;
    try { value = decodeReadingValue(key, await db.get('values', key)); } catch { return true; }
    if (!Array.isArray(value) || value.length) return true;
  }
  return false;
}
/** Queues from earlier sign-ins, as exported for review. Their receipts belong to an
 * earlier credential, so they can never be confirmed by this one. */
export async function earlierReadingChanges(sessionId?: string): Promise<Array<[string, unknown]>> {
  const db = await readingDatabase();
  const changes: Array<[string, unknown]> = [];
  for (const key of await db.getAllKeys('values')) {
    if (!isPendingReadingKey(key) || (sessionId !== undefined && key === readingKeys.pending(sessionId))) continue;
    let value: unknown;
    try { value = await readReadingValue(key); } catch { value = await db.get('values', key); }
    changes.push([key, value]);
  }
  return changes;
}
/** Removes earlier queues only while they still match the reviewed export. */
export function removeEarlierReadingChanges(sessionId: string | undefined, reviewed: string): Promise<boolean> {
  return readingLock(async () => {
    const changes = await earlierReadingChanges(sessionId);
    if (JSON.stringify(changes) !== reviewed) return false;
    const db = await readingDatabase(), tx = db.transaction('values', 'readwrite');
    try {
      for (const [key] of changes) await tx.store.delete(key);
      await tx.done;
    } catch (error) { await abortTransaction(tx); throw error; }
    return true;
  });
}
export async function pendingReading(session: ReadingSession): Promise<PendingReading[]> {
  const stored = await readReadingValue(readingKeys.pending(session.id));
  const data = stored === undefined ? [] : stored;
  const ids = new Set<string>();
  if (!Array.isArray(data) || !data.every((op: unknown): op is PendingReading => {
    if (!isPendingReading(op, session.id) || ids.has(op.id)) return false;
    ids.add(op.id); return true;
  })) throw new Error('Pending Reading changes could not be read. Export your Reading data before changing browser storage.');
  return data;
}
export async function readingLock<T>(action: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('This browser cannot safely send Reading changes. Use a current Safari, Chrome, or Firefox.');
  return navigator.locks.request('crate-reading-mutations-v1', action);
}
export async function readingDrainLock<T>(action: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('This browser cannot safely send Reading changes. Use a current Safari, Chrome, or Firefox.');
  return navigator.locks.request('crate-reading-drain-v1', action);
}
export async function clearReadingData(isCurrent: () => boolean = () => true): Promise<void> {
  if (!isCurrent()) return;
  localStorage.removeItem(READING_SESSION_KEY);
  window.dispatchEvent(new Event(READING_CHANGED_EVENT));
  // Serialize with in-flight cache writes. Credential checks stop later completions.
  const db = await readingDatabase();
  if (!isCurrent() || localStorage.getItem(READING_SESSION_KEY) !== null) return;
  const tx = db.transaction('values', 'readwrite');
  await tx.store.clear();
  if (!isCurrent() || localStorage.getItem(READING_SESSION_KEY) !== null) { await abortTransaction(tx); return; }
  await tx.done;
  window.dispatchEvent(new Event(READING_CHANGED_EVENT));
}
export async function exportReadingData(): Promise<void> {
  const db = await readingDatabase();
  const data: Record<string, unknown> = {}, unreadable: string[] = [];
  for (const key of await db.getAllKeys('values')) {
    if (key === 'share-key' || key === 'share-key-id') continue;
    const raw = await db.get('values', key);
    try { data[key] = await readReadingValue(key); }
    catch { data[key] = raw; unreadable.push(key); }
  }
  // Export healthy records as readable recovery data and preserve opaque damaged
  // records alongside their wrapped local keys. Never silently omit queued work.
  let wrappedKeys: unknown[] = [];
  try { wrappedKeys = await exportWrappedLocalKeys(); } catch { unreadable.push('encryption-keys'); }
  downloadJson('crate-reading-recovery.json', { format: 1, origin: location.origin, data, wrappedKeys, unreadable });
}

/** Drop ciphertext attempts only after their durable semantic commands settled.
 * The caller holds readingLock, which also serializes edits from other tabs. */
export async function pruneReadingAttempts(session: ReadingSession): Promise<void> {
  const pending = await pendingReading(session);
  const retained = new Set(pending.flatMap(op => {
    if (!op.body) return [];
    try { const body = JSON.parse(op.body) as { operationId?: unknown }; return typeof body.operationId === 'string' ? [body.operationId] : []; } catch { throw new Error('Pending Reading change needs recovery.'); }
  }));
  const db = await readingDatabase(); assertReadingSession(session);
  const prefix = readingKeys.attemptPrefix(session.id), tx = db.transaction('values', 'readwrite');
  try {
    for (const key of await tx.store.getAllKeys()) if (key.startsWith(prefix) && !retained.has(key.slice(prefix.length))) await tx.store.delete(key);
    assertReadingSession(session); await tx.done;
  } catch (error) { await abortTransaction(tx); throw error; }
}

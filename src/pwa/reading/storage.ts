import { decodeReadingValue } from './private-storage';
import type { PendingReading } from './outbox';
import { isPendingReading, isReadingDraft } from './storage-validation';
import { downloadJson } from '../download';
import { readingDatabase, readReadingValue, writeReadingValue } from './database';
import { assertReadingSession, READING_SESSION_KEY, type ReadingSession } from './session';

export { assertReadingSession, readingSession, READING_SESSION_KEY, type ReadingSession } from './session';
export { readReadingCache, readReadingArticle, commitReadingCache, cacheReadingArticle, readEncryptedReadingIndex, writeEncryptedReadingIndex, type ReadingCache } from './cache';

// Feature callers use these scoped operations; database keys remain inside storage.
interface ReadingDraft { url: string }
interface ReadingAttempt { requestHash: string; body: string; generation?: number }

async function readDraft(key: string): Promise<ReadingDraft | undefined> {
  const value = await readReadingValue(key);
  if (value === undefined) return undefined;
  if (!isReadingDraft(value)) throw new Error('The saved Reading draft could not be read. Export your Reading data before changing browser storage.');
  return value;
}

export function readReadingDraft(session: ReadingSession): Promise<ReadingDraft | undefined> {
  return readDraft(`draft:${session.id}`);
}
export function saveReadingDraft(session: ReadingSession, draft: ReadingDraft): Promise<void> {
  return writeReadingValue(`draft:${session.id}`, draft, session);
}
export function readReadingShare(id: string): Promise<ReadingDraft | undefined> {
  return readDraft(`share:${id}`);
}
export function removeReadingShare(session: ReadingSession, id: string): Promise<void> {
  return writeReadingValue(`share:${id}`, null, session);
}
export function savePendingReading(session: ReadingSession, pending: PendingReading[]): Promise<void> {
  return writeReadingValue(`pending:${session.id}`, pending, session);
}
export function readReadingAttempt(session: ReadingSession, id: string): Promise<unknown> {
  return readReadingValue(`attempt:${session.id}:${id}`);
}
export function writeReadingAttempt(session: ReadingSession, id: string, attempt: ReadingAttempt): Promise<void> {
  return writeReadingValue(`attempt:${session.id}:${id}`, attempt, session);
}

export async function hasEarlierReadingChanges(sessionId?: string): Promise<boolean> {
  const db = await readingDatabase();
  for (const key of await db.getAllKeys('values')) {
    if (!key.startsWith('pending:') || key === `pending:${sessionId}`) continue;
    let value: unknown;
    try { value = decodeReadingValue(key, await db.get('values', key)); } catch { return true; }
    if (!Array.isArray(value) || value.length) return true;
  }
  return false;
}
export async function pendingReading(session: ReadingSession): Promise<PendingReading[]> {
  const stored = await readReadingValue(`pending:${session.id}`);
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
  document.cookie = 'crate-reading-install=; Max-Age=0; Path=/notifications; SameSite=Strict; Secure';
  window.dispatchEvent(new Event('crate-reading-change'));
  // Serialize with in-flight cache writes. Credential checks stop later completions.
  const db = await readingDatabase();
  if (!isCurrent() || localStorage.getItem(READING_SESSION_KEY) !== null) return;
  const tx = db.transaction('values', 'readwrite');
  await tx.store.clear();
  if (!isCurrent() || localStorage.getItem(READING_SESSION_KEY) !== null) { tx.abort(); await tx.done.catch(() => {}); return; }
  await tx.done;
  window.dispatchEvent(new Event('crate-reading-change'));
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
  try { wrappedKeys = await (await import('../encryption-keys')).exportWrappedLocalKeys(); } catch { unreadable.push('encryption-keys'); }
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
  const prefix = `attempt:${session.id}:`, tx = db.transaction('values', 'readwrite');
  try {
    for (const key of await tx.store.getAllKeys()) if (key.startsWith(prefix) && !retained.has(key.slice(prefix.length))) await tx.store.delete(key);
    assertReadingSession(session); await tx.done;
  } catch (error) { try { tx.abort(); } catch { /* already aborted */ } await tx.done.catch(() => {}); throw error; }
}

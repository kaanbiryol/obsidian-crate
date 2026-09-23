import { openDB, type IDBPDatabase, type DBSchema } from 'idb';
import type { ReadingItem } from '@/reading/core/model';
import { AUTH_TOKEN_KEY } from '../config';
export const READING_SESSION_KEY = 'crate-reading-session-v1';
export interface ReadingSession { token: string; id: string; folderPath: string; generation: string; expiresAt: number; source?: 'reminders' }
export interface PendingReading { id: string; sessionId: string; action: 'capture' | 'update' | 'retry'; intent: Record<string, unknown>; body?: string; error?: string; review?: boolean }
export interface ReadingCache { items: ReadingItem[]; issues: Array<{ path: string; message: string }>; savedAt: number }
interface ReadingDatabase extends DBSchema { values: { key: string; value: unknown } }
let opening: Promise<IDBPDatabase<ReadingDatabase>> | undefined;
export function readingDatabase(): Promise<IDBPDatabase<ReadingDatabase>> {
  if (opening) return opening;
  let abandoned = false;
  const request = openDB<ReadingDatabase>('crate-reading-v1', 1, { upgrade(db, _old, _new, tx) {
    if (abandoned) { tx.abort(); return; }
    db.createObjectStore('values');
  }, blocking() { void opening?.then(db => db.close()); opening = undefined; } });
  opening = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { abandoned = true; opening = undefined; reject(new Error('Reading storage is blocked. Close other Crate tabs and retry.')); }, 4000);
    request.then(db => { clearTimeout(timeout); if (abandoned) db.close(); else resolve(db); }, error => { clearTimeout(timeout); opening = undefined; reject(error instanceof Error ? error : new Error('Reading storage is unavailable.')); });
  });
  return opening;
}
export function readingSession(): ReadingSession | null {
  const raw = localStorage.getItem(READING_SESSION_KEY);
  if (!raw) return null;
  const value = JSON.parse(raw) as ReadingSession;
  if (!value.token || !value.id || !value.folderPath || !value.generation || !Number.isFinite(value.expiresAt)) throw new Error('Reading sign-in could not be read. Reconnect from Obsidian settings.');
  if (value.source && value.source !== 'reminders') throw new Error('Reading sign-in could not be read. Reconnect from Obsidian settings.');
  if (value.source === 'reminders' && localStorage.getItem(AUTH_TOKEN_KEY) !== value.token) return null;
  return value;
}
export function assertReadingSession(session: ReadingSession) {
  const current = readingSession();
  if (current?.id !== session.id || current.token !== session.token || current.generation !== session.generation) throw new Error('Reading sign-in changed. Reload this page.');
}
export async function readValue<T>(key: string): Promise<T | undefined> { return (await readingDatabase()).get('values', key) as Promise<T | undefined>; }
export async function writeValue(key: string, value: unknown, session?: ReadingSession): Promise<void> {
  const db = await readingDatabase();
  if (session) assertReadingSession(session);
  if (value === null) await db.delete('values', key); else await db.put('values', value, key);
}
export async function pendingReading(session: ReadingSession): Promise<PendingReading[]> {
  const data = await readValue<PendingReading[]>(`pending:${session.id}`) ?? [];
  if (!Array.isArray(data) || data.some(op => !op.id || op.sessionId !== session.id || !['capture','update','retry'].includes(op.action) || !op.intent || op.body !== undefined && typeof op.body !== 'string')) throw new Error('Pending Reading changes could not be read. Export your Reading data before changing browser storage.');
  return data;
}
export async function readingLock<T>(action: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('This browser cannot safely send Reading changes. Use a current Safari, Chrome, or Firefox.');
  return navigator.locks.request('crate-reading-mutations-v1', action) as Promise<T>;
}
export async function cacheReadingArticle(session: ReadingSession, item: ReadingItem, markdown: string) {
  const db = await readingDatabase(); assertReadingSession(session);
  const tx = db.transaction('values', 'readwrite');
  const key = `article:${session.id}:${item.crate_reading_id}`;
  await tx.store.put({ item, markdown, usedAt: Date.now() }, key);
  const keys = (await tx.store.getAllKeys()).filter(k => String(k).startsWith(`article:${session.id}:`));
  const entries = await Promise.all(keys.map(async k => ({ key: k, value: await tx.store.get(k) as { markdown: string; usedAt: number } })));
  entries.sort((a, b) => b.value.usedAt - a.value.usedAt);
  let bytes = 0;
  for (let i = 0; i < entries.length; i++) { const entry = entries[i]!; bytes += new TextEncoder().encode(entry.value.markdown).byteLength;
    if (i >= 50 || bytes > 20 * 1024 * 1024) await tx.store.delete(entry.key);
  }
  await tx.done;
}
export async function clearReadingData(): Promise<void> {
  localStorage.removeItem(READING_SESSION_KEY);
  document.cookie = 'crate-reading-install=; Max-Age=0; Path=/notifications; SameSite=Strict; Secure';
  window.dispatchEvent(new Event('crate-reading-change'));
  // Serialize with in-flight cache writes. Credential checks stop later completions.
  const db = await readingDatabase(); await db.clear('values');
  window.dispatchEvent(new Event('crate-reading-change'));
}
export async function exportReadingData(): Promise<void> {
  const db = await readingDatabase(), tx = db.transaction('values');
  const data: Record<string, unknown> = Object.fromEntries(await Promise.all((await tx.store.getAllKeys()).map(async key => [key, await tx.store.get(key)] as const)));
  const blob = new Blob([JSON.stringify({ format: 1, origin: location.origin, data }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = 'crate-reading-recovery.json'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

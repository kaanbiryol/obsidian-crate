import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { readingUrl, validateReadingMetadata } from '@/reading/core/model';
import { AUTH_TOKEN_KEY } from '../config';
import { capturePwaSession } from '../session-generation';
import { READING_SESSION_KEY, assertReadingSession, readingDatabase, readingDrainLock, readingLock, readingSession, pendingReading, writeValue, type PendingReading, type ReadingSession, type ReadingCache } from './storage';
export class ReadingApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }

export async function connectReadingFromReminders(): Promise<ReadingSession | null> {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (!token) return null;
  const sessionCurrent = capturePwaSession();
  const response = await fetch('/reading/session', { cache: 'no-store', signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${token}`, [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current) } });
  const data = await response.json() as { id?: unknown; folderPath?: unknown; generation?: unknown; expiresAt?: unknown; error?: string };
  if (!sessionCurrent() || localStorage.getItem(AUTH_TOKEN_KEY) !== token) return readingSession();
  if (!response.ok) throw new ReadingApiError(data.error ?? 'Reading is unavailable.', response.status);
  if (typeof data.id !== 'string' || !data.id || typeof data.folderPath !== 'string' || !data.folderPath
    || typeof data.generation !== 'string' || !data.generation || typeof data.expiresAt !== 'number' || !Number.isFinite(data.expiresAt)) {
    throw new Error('Update your Crate server to use Reading with this app.');
  }
  const existing = readingSession();
  if (existing && existing.source !== 'reminders') return existing;
  if (existing?.token === token && existing.generation === data.generation) return existing;
  const next: ReadingSession = { token, id: `reminders:${data.id}:${data.generation}`, folderPath: data.folderPath,
    generation: data.generation, expiresAt: data.expiresAt, source: 'reminders' };
  localStorage.setItem(READING_SESSION_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event('crate-reading-change'));
  return next;
}
export async function readingRequest<T>(path: string, session: ReadingSession | null, body?: string): Promise<T> {
  if (session) assertReadingSession(session);
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: AbortSignal.timeout(20_000),
    headers: { ...(session ? { Authorization: `Bearer ${session.token}` } : {}), 'Content-Type': 'application/json', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current) }, body });
  const data = await response.json() as T & { error?: string };
  if (session) assertReadingSession(session);
  if (!response.ok) throw new ReadingApiError(data.error ?? 'Reading request failed.', response.status);
  return data;
}
export async function loadReading(session: ReadingSession): Promise<ReadingCache> {
  const cache: ReadingCache = { items: [], issues: [], savedAt: Date.now() }; let cursor: string | null = null;
  do {
    const page: { items: Array<Record<string, unknown>>; issues: ReadingCache['issues']; cursor: string | null } = await readingRequest(`/reading/list${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, session);
    if (!Array.isArray(page.items) || !Array.isArray(page.issues) || cache.items.length > 10_000) throw new Error('Reading library response is too large or unreadable.');
    cache.items.push(...page.items.map(item => ({ ...validateReadingMetadata(item), path: String(item.path) }))); cache.issues.push(...page.issues);
    if (page.cursor && page.cursor === cursor) throw new Error('Reading library did not advance.'); cursor = page.cursor;
  } while (cursor);
  const db = await readingDatabase(); assertReadingSession(session);
  const tx = db.transaction('values', 'readwrite'), prefix = `article:${session.id}:`;
  const ids = new Set(cache.items.map(item => item.crate_reading_id));
  for (const key of await tx.store.getAllKeys()) if (key.startsWith(prefix) && !ids.has(key.slice(prefix.length))) await tx.store.delete(key);
  await tx.done;
  await writeValue(`list:${session.id}`, cache, session);
  return cache;
}
export async function queueReading(session: ReadingSession, action: PendingReading['action'], intent: Record<string, unknown>) {
  if (action === 'capture') readingUrl(intent.url);
  return readingLock(async () => {
    assertReadingSession(session); const queue = await pendingReading(session);
    if (queue.length >= 200) throw new Error('Send or review pending Reading changes before adding more.');
    if (action !== 'capture' && queue.some(op => op.intent.id === intent.id)) throw new Error('This item already has a pending change. Send it before editing again.');
    queue.push({ id: crypto.randomUUID(), sessionId: session.id, action, intent });
    await writeValue(`pending:${session.id}`, queue, session);
    return queue;
  });
}
export async function drainReading(session: ReadingSession): Promise<ReadingCache | undefined> {
  if (!navigator.onLine) return undefined;
  return readingDrainLock(async () => {
    assertReadingSession(session);
    const queue = await pendingReading(session);
    if (!queue.some(op => !op.review)) return undefined;
    const info = await readingRequest<{ day: number; generation: string }>('/reading/session', session);
    if (info.generation !== session.generation) throw new Error('Reading destination changed. Export and review pending work.');
    const confirmed = new Set<string>();
    for (const candidate of queue) {
      if (candidate.review) continue;
      const op = await readingLock(async () => {
        const current = await pendingReading(session), next = current.find(entry => entry.id === candidate.id);
        if (!next || next.review) return null;
        if (!next.body) {
          next.body = JSON.stringify({ ...next.intent, operationId: createReminderOperationId(info.day) });
          // Store exact dispatch bytes and ID before making the request.
          await writeValue(`pending:${session.id}`, current, session);
        }
        return next;
      });
      if (!op) continue;
      try {
        await readingRequest(`/reading/${op.action}`, session, op.body);
        confirmed.add(op.id);
      } catch (error) {
        await readingLock(async () => {
          const current = await pendingReading(session), failed = current.find(entry => entry.id === op.id);
          if (!failed) return;
          failed.error = error instanceof Error ? error.message : 'Save has not been confirmed. Retry when connected.';
          failed.review = error instanceof ReadingApiError && [400, 409, 410, 413].includes(error.status);
          await writeValue(`pending:${session.id}`, current, session);
        });
        break;
      }
    }
    if (!confirmed.size) return undefined;
    // Confirm once for this batch before removing any durable command. Another
    // tab may have queued more work while the network requests were in flight.
    const cache = await loadReading(session);
    await readingLock(async () => {
      const current = await pendingReading(session);
      await writeValue(`pending:${session.id}`, current.filter(op => !confirmed.has(op.id)), session);
    });
    return cache;
  });
}

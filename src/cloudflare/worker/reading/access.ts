import { limitNotificationAction } from '../rate-limit';
import { changedRows } from '../db';
import { sha256Hex } from '../auth';
import { validateReadingFolder } from '@/reading/settings';
import type { AuthPrincipal } from '../authenticate';
import { policy, authority, ReadingError, readingResponse, type ReadingPolicy } from './common';

export async function updatePolicy(db: D1Database, body: Record<string, unknown>) {
  const existing = await policy(db);
  if ((body.revision ?? null) !== (existing?.revision ?? null)) throw new ReadingError('Reading settings changed on another device. Refresh them first.', 409);
  if (typeof body.enabled !== 'boolean' || typeof body.folderPath !== 'string') throw new ReadingError('Choose a Reading folder and enabled state.');
  const reminders = await db.prepare('SELECT folder_path FROM notification_policy WHERE id=1').first<{ folder_path: string }>();
  let folder: string;
  try { folder = validateReadingFolder(body.folderPath, reminders?.folder_path); }
  catch (error) { throw new ReadingError(error instanceof Error ? error.message : 'Choose a valid Reading folder.'); }
  if (existing && folder !== existing.folder_path) {
    if (existing.enabled || body.enabled || await db.prepare('SELECT 1 FROM reading_jobs LIMIT 1').first()) throw new ReadingError('Let pending extraction finish, then disable Reading before changing its folder.', 409);
  }
  const current: ReadingPolicy = { enabled: Number(body.enabled), folder_path: folder,
    generation: existing && existing.folder_path === folder ? existing.generation : crypto.randomUUID(), revision: crypto.randomUUID() };
  await db.prepare(`INSERT INTO reading_policy(id, enabled, folder_path, generation, revision) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, folder_path=excluded.folder_path, generation=excluded.generation, revision=excluded.revision`)
    .bind(current.enabled, folder, current.generation, current.revision).run();
  return readingResponse({ policy: current });
}
function secret() { return `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, ''); }
export async function issueReadingAccess(db: D1Database, current: ReadingPolicy, body: Record<string, unknown>, origin: string) {
  const token = secret();
  if (body.kind === 'capture') {
    const id = crypto.randomUUID(), expiresAt = Date.now() + 90 * 86400_000;
    await db.prepare(`INSERT INTO auth_tokens(id, token_hash, device_name, platform, scope, folder_path, reading_generation, expires_at)
      VALUES (?, ?, 'Save to Crate shortcut', 'shortcut', 'reading_capture', ?, ?, ?)`)
      .bind(id, await sha256Hex(token), current.folder_path, current.generation, expiresAt).run();
    return readingResponse({ token, id, expiresAt, endpoint: `${origin}/reading/prepare` });
  }
  if (body.kind !== 'reading') throw new ReadingError('Choose Reading or capture access.');
  await db.prepare(`INSERT INTO reading_enrollments(token_hash, generation, scope, expires_at) VALUES (?, ?, 'reading', ?)`)
    .bind(await sha256Hex(token), current.generation, Date.now() + 10 * 60_000).run();
  return readingResponse({ token, url: `${origin}/notifications?section=reading#reading=${token}` });
}
export async function exchangeReadingAccess(db: D1Database, body: Record<string, unknown>, request: Request) {
  if (typeof body.token !== 'string' || body.token.length > 256) throw new ReadingError('Open a fresh Reading setup link.', 401);
  const hash = await sha256Hex(body.token), current = await policy(db);
  if (!current?.enabled) throw new ReadingError('Reading is disabled.', 403);
  const enrollment = await db.prepare('SELECT scope FROM reading_enrollments WHERE token_hash=? AND expires_at>? AND generation=?')
    .bind(hash, Date.now(), current.generation).first<{ scope: string }>();
  if (!enrollment || !['reading', 'reading_install'].includes(enrollment.scope)) throw new ReadingError('This setup link expired or was already used. Open a fresh one from Crate settings.', 401);
  const limited = await limitNotificationAction(request, db, hash); if (limited) return limited;
  const id = crypto.randomUUID(), token = secret(), expiresAt = Date.now() + 90 * 86400_000;
  const installToken = enrollment.scope === 'reading' ? secret() : undefined;
  const results = await db.batch([
    db.prepare(`INSERT INTO auth_tokens(id, token_hash, device_name, platform, scope, folder_path, reading_generation, expires_at)
      SELECT ?, ?, 'Reading web app', 'web', 'reading', ?, ?, ? WHERE EXISTS (SELECT 1 FROM reading_enrollments WHERE token_hash=? AND expires_at>?)`)
      .bind(id, await sha256Hex(token), current.folder_path, current.generation, expiresAt, hash, Date.now()),
    ...(installToken ? [db.prepare(`INSERT INTO reading_enrollments(token_hash,generation,scope,expires_at)
      SELECT ?, ?, 'reading_install', ? WHERE changes()=1`).bind(await sha256Hex(installToken), current.generation, Date.now()+10*60_000)] : []),
    db.prepare('DELETE FROM reading_enrollments WHERE token_hash=?').bind(hash),
  ]);
  if (changedRows(results[0]) !== 1) throw new ReadingError('This setup link was already used.', 401);
  return readingResponse({ token, id, expiresAt, ...(installToken ? { installToken } : {}), folderPath: current.folder_path, generation: current.generation });
}
export async function prepareHandoff(db: D1Database, principal: AuthPrincipal, body: Record<string, unknown>, origin: string) {
  const current = await authority(db, principal);
  const { readingUrl } = await import('@/reading/core/model');
  const { createReminderOperationId } = await import('@/protocol/reminder-operation');
  // The Shortcut persists this exact prepared operation in the capability. Reopening it is an exact retry.
  let url: string;
  try { url = readingUrl(body.url); } catch { throw new ReadingError('Share a complete HTTP or HTTPS link.'); }
  const prepared = { url, ...(typeof body.title === 'string' ? { title: body.title.slice(0, 1000) } : {}),
    operationId: createReminderOperationId(Math.floor(Date.now() / 86400_000)) };
  const token = secret(), expiresAt = Date.now() + 5 * 60_000;
  await db.prepare('INSERT INTO reading_handoffs(token_hash, principal_id, generation, body, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256Hex(token), principal.tokenId, current.generation, JSON.stringify(prepared), expiresAt).run();
  return readingResponse({ launchUrl: `${origin}/notifications/save-reading#${token}`, expiresAt });
}
export async function handoffAuthority(db: D1Database, request: Request) {
  const token = request.headers.get('X-Crate-Capture') ?? '';
  if (!/^[a-f0-9]{64}$/.test(token)) throw new ReadingError('This save link is missing. Share the article again.', 401);
  const row = await db.prepare(`SELECT h.body, h.generation, a.id, a.scope, a.folder_path, a.reading_generation FROM reading_handoffs h
    JOIN auth_tokens a ON a.id=h.principal_id WHERE h.token_hash=? AND h.expires_at>? AND (a.expires_at IS NULL OR a.expires_at>?)`)
    .bind(await sha256Hex(token), Date.now(), Date.now()).first<{ body: string; generation: string; id: string; scope: string; folder_path: string; reading_generation: string }>();
  if (!row || !['reading_capture', 'reading', 'vault'].includes(row.scope)) throw new ReadingError('This save link expired or its access was revoked. Share the article again.', 410);
  const principal: AuthPrincipal = { tokenId: row.id, scope: row.scope as AuthPrincipal['scope'], folderPath: row.folder_path, readingGeneration: row.reading_generation };
  const current = await authority(db, principal);
  if (current.generation !== row.generation) throw new ReadingError('Reading settings changed. Share the article again.', 410);
  return { principal, current, body: JSON.parse(row.body) as Record<string, unknown> };
}

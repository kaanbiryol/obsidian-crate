import { validateReadingFolder } from '@/reading/settings';
import type { AuthPrincipal } from '../auth/authenticate';
import { policy, authority, canPrepareReadingHandoff, ReadingError, readingResponse } from './common';
import type { ReadingPolicy } from '@/protocol/reading-policy';
import { isSha256Hex } from '@/platform/validation';
import { sha256Hex } from '@/platform/sha256';
import { createRandomHexToken } from '@/platform/random-hex';

export async function updatePolicy(db: D1Database, body: Record<string, unknown>) {
  const existing = await policy(db);
  if ((body.revision ?? null) !== (existing?.revision ?? null)) throw new ReadingError('Reading settings changed on another device. Refresh them first.', 409);
  if (typeof body.enabled !== 'boolean' || typeof body.folderPath !== 'string') throw new ReadingError('Choose a Reading folder and enabled state.');
  const reminders = await db.prepare('SELECT folder_path FROM notification_policy WHERE id=1').first<{ folder_path: string }>();
  let folder: string;
  try { folder = validateReadingFolder(body.folderPath, reminders?.folder_path); }
  catch (error) { throw new ReadingError(error instanceof Error ? error.message : 'Choose a valid Reading folder.'); }
  if (existing && folder !== existing.folder_path) {
    if (existing.enabled || body.enabled || await db.prepare('SELECT 1 FROM reading_jobs UNION ALL SELECT 1 FROM reading_captures LIMIT 1').first()) throw new ReadingError('Let pending extraction finish, then turn off article fetching before changing its folder.', 409);
  }
  const current: ReadingPolicy = { enabled: Number(body.enabled), folder_path: folder,
    generation: existing && existing.folder_path === folder ? existing.generation : crypto.randomUUID(), revision: crypto.randomUUID() };
  await db.prepare(`INSERT INTO reading_policy(id, enabled, folder_path, generation, revision) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, folder_path=excluded.folder_path, generation=excluded.generation, revision=excluded.revision`)
    .bind(current.enabled, folder, current.generation, current.revision).run();
  return readingResponse({ policy: current });
}
export async function prepareHandoff(db: D1Database, principal: AuthPrincipal, body: Record<string, unknown>, origin: string) {
  if (!canPrepareReadingHandoff(principal.scope)) throw new ReadingError('Reading access is required.', 403);
  const current = await authority(db, principal);
  const { readingUrl } = await import('@/reading/core/model');
  const { createReminderOperationId } = await import('@/protocol/reminder-operation');
  // The Shortcut persists this exact prepared operation in the capability. Reopening it is an exact retry.
  let url: string;
  try { url = readingUrl(body.url); } catch { throw new ReadingError('Share a complete HTTP or HTTPS link.'); }
  const prepared = { url, ...(typeof body.title === 'string' ? { title: body.title.slice(0, 1000) } : {}),
    operationId: createReminderOperationId(Math.floor(Date.now() / 86400_000)) };
  const token = createRandomHexToken(), expiresAt = Date.now() + 5 * 60_000;
  await db.prepare('INSERT INTO reading_handoffs(token_hash, principal_id, generation, body, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256Hex(token), principal.tokenId, current.generation, JSON.stringify(prepared), expiresAt).run();
  return readingResponse({ launchUrl: `${origin}/notifications/save-reading#${token}`, expiresAt });
}
export async function handoffAuthority(db: D1Database, request: Request) {
  const token = request.headers.get('X-Crate-Capture') ?? '';
  if (!isSha256Hex(token)) throw new ReadingError('This save link is missing. Share the article again.', 401);
  const row = await db.prepare(`SELECT h.body, h.generation, a.id, a.scope, a.folder_path, a.reading_generation FROM reading_handoffs h
    JOIN auth_tokens a ON a.id=h.principal_id WHERE h.token_hash=? AND h.expires_at>? AND (a.expires_at IS NULL OR a.expires_at>?)`)
    .bind(await sha256Hex(token), Date.now(), Date.now()).first<{ body: string; generation: string; id: string; scope: string; folder_path: string; reading_generation: string }>();
  if (!row || !canPrepareReadingHandoff(row.scope)) throw new ReadingError('This save link expired or its access was revoked. Share the article again.', 410);
  const principal: AuthPrincipal = { tokenId: row.id, scope: row.scope, folderPath: row.folder_path, readingGeneration: row.reading_generation };
  const current = await authority(db, principal);
  if (current.generation !== row.generation) throw new ReadingError('Reading settings changed. Share the article again.', 410);
  return { principal, current, body: JSON.parse(row.body) as Record<string, unknown> };
}

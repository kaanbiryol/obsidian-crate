import type { AuthPrincipal } from '../authenticate';
import { sha256Hex } from '../auth';
import { changedRows } from '../db';
import { limitNotificationAction } from '../rate-limit';
import { ReadingError, readingResponse, type ReadingPolicy } from './common';

const secret = () => `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
const invalidPairing = () => new ReadingError('This pairing code expired or was already used. Create a new code in Reading settings.', 410);

// Enrollment scopes name the issuer so revoking it also invalidates unredeemed
// codes. Existing library/install exchanges explicitly reject these scopes.
export async function issueShortcutPairing(db: D1Database, principal: AuthPrincipal, current: ReadingPolicy, origin: string) {
  if (principal.scope !== 'reading' && principal.scope !== 'reminders' && principal.scope !== 'vault') throw new ReadingError('Reading access is required.', 403);
  if (!origin.startsWith('https://')) throw new ReadingError('Open Crate over HTTPS to connect an iPhone shortcut.');
  const token = secret(), expiresAt = Date.now() + 10 * 60_000;
  const scope = `reading_capture:${principal.tokenId}`;
  await db.batch([
    db.prepare('DELETE FROM reading_enrollments WHERE scope=?').bind(scope),
    db.prepare('INSERT INTO reading_enrollments(token_hash,generation,scope,expires_at) VALUES (?,?,?,?)')
      .bind(await sha256Hex(token), current.generation, scope, expiresAt),
  ]);
  return readingResponse({ pairingCode: `${origin}/reading/shortcut-exchange#${token}`, expiresAt });
}

// The one-time secret travels in the POST body. Neither a browser session nor a
// long-lived capture credential is included in the distributed Shortcut or URL.
export async function exchangeShortcutPairing(db: D1Database, body: Record<string, unknown>, request: Request) {
  if (typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) throw invalidPairing();
  const hash = await sha256Hex(body.token);
  const grantSql = `FROM reading_enrollments e
    JOIN auth_tokens a ON e.scope='reading_capture:' || a.id
    JOIN reading_policy p ON p.id=1 AND p.enabled=1 AND p.generation=e.generation
    WHERE e.token_hash=? AND e.expires_at>? AND (a.expires_at IS NULL OR a.expires_at>?)
      AND (a.scope='vault' OR (a.scope='reminders' AND a.folder_path IS NOT NULL)
        OR (a.scope='reading' AND a.folder_path=p.folder_path AND a.reading_generation=p.generation))`;
  const now = Date.now();
  const grant = await db.prepare(`SELECT a.id ${grantSql}`).bind(hash, now, now).first<{ id: string }>();
  if (!grant) throw invalidPairing();
  const limited = await limitNotificationAction(request, db, grant.id); if (limited) return limited;
  const token = secret(), id = crypto.randomUUID();
  // Recheck the grant and its issuer within the consume transaction. Concurrent
  // exchanges can create only one credential. A lost reply requires a new code.
  const results = await db.batch([
    db.prepare(`INSERT INTO auth_tokens(id,token_hash,device_name,platform,scope,folder_path,reading_generation,expires_at)
      SELECT ?,?, 'Save to Crate shortcut','shortcut','reading_capture',p.folder_path,p.generation,
        min(?,coalesce(a.expires_at,?)) ${grantSql}`)
      .bind(id, await sha256Hex(token), now + 90 * 86400_000, now + 90 * 86400_000, hash, Date.now(), Date.now()),
    db.prepare('DELETE FROM reading_enrollments WHERE token_hash=?').bind(hash),
  ]);
  if (changedRows(results[0]) !== 1) throw invalidPairing();
  return readingResponse({ endpoint: `${new URL(request.url).origin}/reading/prepare`, authorization: `Bearer ${token}` });
}

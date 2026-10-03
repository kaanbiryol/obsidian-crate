import { PAIRING_LIFETIME, pairingCommitment, samePairingContext, validatePairingContext, validatePairingKey, validatePairingRecord, type PairingRecord } from '../../encryption/pairing/protocol';
import { decodeBase64Url, isEncryptionId } from '../../encryption/encoding';
import type { EncryptionServerState } from '../../encryption/server-state';
import type { AuthPrincipal } from './authenticate';
import { corsResponse } from './cors';
import { parseJsonObject } from './utils';
import { authority as readingAuthority, ReadingError } from './reading/common';

const PREFIX = 'crate_web_pairing:', END = 'crate_web_pairing;';
interface Stored extends PairingRecord { owner: string; approver?: string }
const response = (body: unknown, status = 200) => corsResponse(body, status, { 'Cache-Control': 'no-store' });
const failure = (message: string, status = 409) => response({ error: message }, status);
const visible = (r: Stored): PairingRecord => ({ context: r.context, commitment: r.commitment, expiresAt: r.expiresAt,
  ...(r.responderKey ? { responderKey: r.responderKey } : {}), ...(r.requesterKey ? { requesterKey: r.requesterKey } : {}),
  ...(r.payload ? { payload: r.payload } : {}), ...(r.closed ? { closed: true } : {}) });
const ownerValid = `EXISTS (SELECT 1 FROM auth_tokens a WHERE a.id = json_extract(maintenance_state.value, '$.owner')
  AND a.scope IN ('reminders','reading') AND (a.expires_at IS NULL OR a.expires_at > ?)
  AND (a.scope != 'reading' OR a.reading_generation = (SELECT generation FROM reading_policy WHERE id=1)))`;
const stateValid = `EXISTS (SELECT 1 FROM maintenance_state s WHERE s.key='e2ee:state'
  AND json_extract(s.value,'$.mode')='active' AND json_extract(s.value,'$.vaultId')=? AND json_extract(s.value,'$.generation')=?)`;

/** Expired relay packets are bounded (32 slots) and can never be redeemed. */
export async function pruneEncryptionPairings(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM maintenance_state WHERE key >= ? AND key < ? AND json_extract(value,\'$.expiresAt\') <= ?').bind(PREFIX, END, Date.now()).run();
}

export async function handleEncryptionPairing(request: Request, db: D1Database, principal: AuthPrincipal, state: EncryptionServerState | null): Promise<Response> {
  if (!state || state.mode !== 'active') return failure('Finish encryption setup in Obsidian before connecting an app.');
  const vault = principal.scope === 'vault';
  if (!vault && !['reminders', 'reading'].includes(principal.scope)) return failure('App access is required.', 403);
  if (principal.scope === 'reading' && !await db.prepare('SELECT 1 FROM reading_policy WHERE id=1 AND generation=? AND folder_path=?').bind(principal.readingGeneration ?? '', principal.folderPath ?? '').first()) return failure('Reconnect this app first.', 401);
  if (request.method === 'GET') {
    const id = new URL(request.url).searchParams.get('id');
    if ((!id && !vault) || id && !isEncryptionId(id)) return failure('Choose a pairing request.', 400);
    const rows = await db.prepare(`SELECT value FROM maintenance_state WHERE key >= ? AND key < ?
      AND json_extract(value,'$.expiresAt') > ? AND json_extract(value,'$.context.vaultId')=? AND json_extract(value,'$.context.generation')=?
      AND ${ownerValid} AND (? IS NULL OR key=?) AND (? OR json_extract(value,'$.owner')=?) ORDER BY key LIMIT 32`)
      .bind(PREFIX, END, Date.now(), state.vaultId, state.generation, Date.now(), id, id ? PREFIX + id : '', vault ? 1 : 0, principal.tokenId).all<{ value: string }>();
    const records = rows.results.map(row => JSON.parse(row.value) as Stored)
      .filter(row => id || !row.closed && !row.payload && (!row.approver || row.approver === principal.tokenId));
    return response({ requests: records.map(visible) });
  }
  const parsed = await parseJsonObject(request, 24576);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  try {
    if (body.action === 'start') {
      if (vault) return failure('Start pairing in the web app.', 403);
      validatePairingContext(body.context);
      const c = body.context;
      const scope = state.scopes.find(scope => scope.id === c.scopeId);
      if (c.vaultId !== state.vaultId || c.generation !== state.generation || !scope) return failure('This app connection changed. Start again.');
      // A normal Crate app credential is scoped as reminders but also opens
      // the configured Reading library. Reuse that same authority here.
      const folder = scope.purpose === 'reading' ? (await readingAuthority(db, principal)).folder_path
        : principal.scope === 'reminders' ? principal.folderPath : undefined;
      if (scope.folderPath !== folder) return failure('This app connection changed. Start again.');
      if (typeof body.commitment !== 'string' || decodeBase64Url(body.commitment, 32).length !== 32) return failure('Invalid pairing commitment.', 400);
      const existing = await db.prepare('SELECT value FROM maintenance_state WHERE key=?').bind(PREFIX + c.id).first<{ value: string }>();
      if (existing) {
        const row = JSON.parse(existing.value) as Stored;
        return row.owner === principal.tokenId && samePairingContext(row.context, c) && row.commitment === body.commitment && row.expiresAt > Date.now() && !row.closed
          ? response({ request: visible(row) }) : failure('Start a new pairing request.');
      }
      await pruneEncryptionPairings(db);
      const row: Stored = { context: c, commitment: body.commitment, owner: principal.tokenId, expiresAt: Date.now() + PAIRING_LIFETIME };
      // At most three attempts per app in five minutes, and 32 server-wide.
      // Closed attempts retain their slot until expiry; polling performs no writes.
      const inserted = await db.prepare(`INSERT INTO maintenance_state(key,value) SELECT ?,?
        WHERE (SELECT COUNT(*) FROM maintenance_state WHERE key>=? AND key<?) < 32
        AND (SELECT COUNT(*) FROM maintenance_state WHERE key>=? AND key<? AND json_extract(value,'$.owner')=?) < 3
        AND ${stateValid} AND EXISTS (SELECT 1 FROM auth_tokens WHERE id=? AND (expires_at IS NULL OR expires_at>?))
        ON CONFLICT(key) DO NOTHING RETURNING key`)
        .bind(PREFIX + c.id, JSON.stringify(row), PREFIX, END, PREFIX, END, principal.tokenId, c.vaultId, c.generation, principal.tokenId, Date.now()).first();
      return inserted ? response({ request: visible(row) }) : failure('Pairing is busy. Wait five minutes before trying again.', 429);
    }
    if (!isEncryptionId(body.id)) return failure('Invalid pairing request.', 400);
    const stored = await db.prepare(`SELECT value FROM maintenance_state WHERE key=? AND ${ownerValid}`).bind(PREFIX + body.id, Date.now()).first<{ value: string }>();
    if (!stored) return failure('This pairing expired or was revoked.', 410);
    const previous = JSON.parse(stored.value) as Stored;
    if (previous.expiresAt <= Date.now() || previous.context.vaultId !== state.vaultId || previous.context.generation !== state.generation) return failure('This pairing expired or changed.', 410);
    const owner = previous.owner === principal.tokenId;
    if (!owner && !vault || vault && previous.approver && previous.approver !== principal.tokenId) return failure('This request belongs to another device.', 403);
    const next = { ...previous };
    if (body.action === 'cancel' || body.action === 'finish') {
      if (body.action === 'finish' && (!owner || !previous.payload)) return failure('This transfer is not complete.');
      next.closed = true; delete next.payload;
    } else {
      if (previous.closed) return failure('This pairing ended.', 410);
      if (body.action === 'accept' && vault) {
        validatePairingKey(body.key);
        if (previous.responderKey && previous.responderKey !== body.key) return failure('Another device accepted this request.');
        next.approver = principal.tokenId; next.responderKey = body.key;
      } else if (body.action === 'reveal' && owner && previous.responderKey) {
        validatePairingKey(body.key);
        if (previous.requesterKey && previous.requesterKey !== body.key || await pairingCommitment(previous.context, body.key) !== previous.commitment) return failure('Pairing verification failed.');
        next.requesterKey = body.key;
      } else if (body.action === 'approve' && vault && previous.approver === principal.tokenId && previous.requesterKey) {
        if (typeof body.payload !== 'string' || decodeBase64Url(body.payload, 16384).length < 28) return failure('Invalid encrypted packet.', 400);
        if (previous.payload && previous.payload !== body.payload) return failure('This request was already approved.');
        next.payload = body.payload;
      } else return failure('Invalid pairing step.', 403);
    }
    validatePairingRecord(next);
    if (JSON.stringify(previous) === JSON.stringify(next)) return response({ request: visible(next) });
    const updated = await db.prepare(`UPDATE maintenance_state SET value=?, updated_at=datetime('now') WHERE key=? AND value=? AND ${ownerValid}
      AND ${stateValid} AND EXISTS (SELECT 1 FROM auth_tokens WHERE id=? AND (expires_at IS NULL OR expires_at>?)) RETURNING key`)
      .bind(JSON.stringify(next), PREFIX + body.id, stored.value, Date.now(), state.vaultId, state.generation, principal.tokenId, Date.now()).first();
    return updated ? response({ request: visible(next) }) : failure('Pairing changed. Retry the current step.');
  } catch (error) {
    if (error instanceof ReadingError) return failure(error.message, error.status);
    if (error instanceof Error && /Invalid|pairing|encoding/i.test(error.message)) return failure('Invalid pairing request.', 400);
    throw error;
  }
}

import { PAIRING_LIFETIME, pairingCommitment, samePairingContext, validatePairingContext, validatePairingKey, validatePairingRecord, type PairingRecord } from '../../../encryption/pairing/protocol';
import { decodeBase64Url, isEncryptionId } from '../../../encryption/encoding';
import type { EncryptionServerState } from '../../../encryption/server-state';
import { ENCRYPTION_STATE_SQL } from './state';
import type { AuthPrincipal } from '../auth/authenticate';
import { corsResponse } from '../http/cors';
import { parseJsonObject, SMALL_JSON_BODY_BYTES } from '../http/request-validation';
import { ReadingError } from '../reading/common';

/** Pairings are `grants` rows of this kind, keyed by pairing ID. */
const KIND = 'web_pairing';
interface Stored extends PairingRecord { owner: string; approver?: string }
const response = (body: unknown, status = 200) => corsResponse(body, status, { 'Cache-Control': 'no-store' });
const failure = (message: string, status = 409) => response({ error: message }, status);
const visible = (r: Stored): PairingRecord => ({ context: r.context, commitment: r.commitment, expiresAt: r.expiresAt,
	...(r.responderKey ? { responderKey: r.responderKey } : {}), ...(r.requesterKey ? { requesterKey: r.requesterKey } : {}),
	...(r.payload ? { payload: r.payload } : {}), ...(r.closed ? { closed: true } : {}) });
const ownerValid = `EXISTS (SELECT 1 FROM auth_tokens a WHERE a.id = json_extract(grants.payload, '$.owner')
  AND a.scope IN ('reminders','vault') AND (a.expires_at IS NULL OR a.expires_at > ?))`;
const stateValid = `(json_extract(${ENCRYPTION_STATE_SQL},'$.mode')='active' AND json_extract(${ENCRYPTION_STATE_SQL},'$.vaultId')=?
  AND json_extract(${ENCRYPTION_STATE_SQL},'$.generation')=?)`;

export async function handleEncryptionPairing(request: Request, db: D1Database, principal: AuthPrincipal, state: EncryptionServerState | null): Promise<Response> {
	if (!state || state.mode !== 'active') return failure('Finish encryption setup in Obsidian before connecting an app.');
	const vault = principal.scope === 'vault';
	if (!vault && principal.scope !== 'reminders') return failure('App access is required.', 403);
	if (request.method === 'GET') {
		const id = new URL(request.url).searchParams.get('id');
		if ((!id && !vault) || id && !isEncryptionId(id)) return failure('Choose a pairing request.', 400);
		const rows = await db.prepare(`SELECT payload FROM grants WHERE kind = '${KIND}'
      AND expires_at > ? AND json_extract(payload,'$.context.vaultId')=? AND json_extract(payload,'$.context.generation')=?
      AND ${ownerValid} AND (? IS NULL OR key=?) AND (? OR json_extract(payload,'$.owner')=?) ORDER BY key LIMIT 32`)
			.bind(Date.now(), state.vaultId, state.generation, Date.now(), id, id ?? '', vault ? 1 : 0, principal.tokenId).all<{ payload: string }>();
		// A device never lists its own request for approval.
		const records = rows.results.map(row => JSON.parse(row.payload) as Stored)
			.filter(row => id || row.owner !== principal.tokenId && !row.closed && !row.payload && (!row.approver || row.approver === principal.tokenId));
		return response({ requests: records.map(visible) });
	}
	const parsed = await parseJsonObject(request, SMALL_JSON_BODY_BYTES);
	if (!parsed.ok) return parsed.response;
	const body = parsed.value;
	try {
		if (body.action === 'start') {
			validatePairingContext(body.context);
			const c = body.context;
			if (c.vaultId !== state.vaultId || c.generation !== state.generation) return failure('This app connection changed. Start again.');
			if (typeof body.commitment !== 'string' || decodeBase64Url(body.commitment, 32).length !== 32) return failure('Invalid pairing commitment.', 400);
			const existing = await db.prepare(`SELECT payload FROM grants WHERE kind = '${KIND}' AND key = ?`).bind(c.id).first<{ payload: string }>();
			if (existing) {
				const row = JSON.parse(existing.payload) as Stored;
				return row.owner === principal.tokenId && samePairingContext(row.context, c) && row.commitment === body.commitment && row.expiresAt > Date.now() && !row.closed
					? response({ request: visible(row) }) : failure('Start a new pairing request.');
			}
			const row: Stored = { context: c, commitment: body.commitment, owner: principal.tokenId, expiresAt: Date.now() + PAIRING_LIFETIME };
			// At most three attempts per app in five minutes, and 32 server-wide.
			// Closed attempts retain their slot until expiry; polling performs no writes.
			const inserted = await db.prepare(`INSERT INTO grants(kind,key,payload,expires_at) SELECT '${KIND}',?,?,?
        WHERE (SELECT COUNT(*) FROM grants WHERE kind='${KIND}' AND expires_at>?) < 32
        AND (SELECT COUNT(*) FROM grants WHERE kind='${KIND}' AND expires_at>? AND json_extract(payload,'$.owner')=?) < 3
        AND ${stateValid} AND EXISTS (SELECT 1 FROM auth_tokens WHERE id=? AND (expires_at IS NULL OR expires_at>?))
        ON CONFLICT(kind,key) DO NOTHING RETURNING key`)
				.bind(c.id, JSON.stringify(row), row.expiresAt, Date.now(), Date.now(), principal.tokenId, c.vaultId, c.generation, principal.tokenId, Date.now()).first();
			return inserted ? response({ request: visible(row) }) : failure('Pairing is busy. Wait five minutes before trying again.', 429);
		}
		if (!isEncryptionId(body.id)) return failure('Invalid pairing request.', 400);
		const stored = await db.prepare(`SELECT payload FROM grants WHERE kind='${KIND}' AND key=? AND ${ownerValid}`).bind(body.id, Date.now()).first<{ payload: string }>();
		if (!stored) return failure('This pairing expired or was revoked.', 410);
		const previous = JSON.parse(stored.payload) as Stored;
		if (previous.expiresAt <= Date.now() || previous.context.vaultId !== state.vaultId || previous.context.generation !== state.generation) return failure('This pairing expired or changed.', 410);
		const owner = previous.owner === principal.tokenId;
		if (!owner && (!vault || previous.approver && previous.approver !== principal.tokenId)) return failure('This request belongs to another device.', 403);
		const next = { ...previous };
		if (body.action === 'cancel' || body.action === 'finish') {
			if (body.action === 'finish' && (!owner || !previous.payload)) return failure('This transfer is not complete.');
			next.closed = true; delete next.payload;
		} else {
			if (previous.closed) return failure('This pairing ended.', 410);
			if (body.action === 'accept' && vault && !owner) {
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
		const updated = await db.prepare(`UPDATE grants SET payload=? WHERE kind='${KIND}' AND key=? AND payload=? AND ${ownerValid}
      AND ${stateValid} AND EXISTS (SELECT 1 FROM auth_tokens WHERE id=? AND (expires_at IS NULL OR expires_at>?)) RETURNING key`)
			.bind(JSON.stringify(next), body.id, stored.payload, Date.now(), state.vaultId, state.generation, principal.tokenId, Date.now()).first();
		return updated ? response({ request: visible(next) }) : failure('Pairing changed. Retry the current step.');
	} catch (error) {
		if (error instanceof ReadingError) return failure(error.message, error.status);
		if (error instanceof Error && /Invalid|pairing|encoding/i.test(error.message)) return failure('Invalid pairing request.', 400);
		throw error;
	}
}

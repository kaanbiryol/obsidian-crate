import { corsResponse } from '../cors';
import { changedRows } from '../db';
import { limitNotificationAction } from '../rate-limit';
import { parseJsonObject, parseOptionalString } from '../request-validation';
import { isSha256Hex } from '../../../platform/validation';
import { sha256Hex } from '../../../platform/sha256';
import { DEVICE_PAIRING_END, DEVICE_PAIRING_PREFIX, parseDevicePairingRecord, type DevicePairingRecord } from '../../../protocol/device-pairing';

const respond = (body: unknown, status = 200) => corsResponse(body, status, { 'Cache-Control': 'no-store' });
const invalid = () => respond({ error: 'This pairing code expired or was already used. Create a new one on your desktop.' }, 410);
const redeemed = (record: DevicePairingRecord) => respond({ tokenId: record.id, deployment: record.deployment });

/** Redeems a one-use code issued through the Cloudflare API for a new vault device token.
 * The device generates its token and sends only the hash. A retry with the same hash
 * after a lost response returns the same result until the code expires. */
export async function exchangeDevicePairing(request: Request, db: D1Database): Promise<Response> {
	const parsed = await parseJsonObject(request, 4096);
	if (!parsed.ok) return parsed.response;
	const body = parsed.value;
	const deviceId = parseOptionalString(body.deviceId, 128), deviceName = parseOptionalString(body.deviceName, 128), platform = parseOptionalString(body.platform, 32);
	if (!isSha256Hex(body.code) || !isSha256Hex(body.tokenHash) || !deviceId || !deviceName || !platform) return respond({ error: 'Invalid pairing request.' }, 400);
	await db.prepare('DELETE FROM maintenance_state WHERE key >= ? AND key < ? AND json_extract(value, \'$.expiresAt\') <= ?')
		.bind(DEVICE_PAIRING_PREFIX, DEVICE_PAIRING_END, Date.now()).run();
	const key = DEVICE_PAIRING_PREFIX + await sha256Hex(body.code);
	const stored = await db.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(key).first<{ value: string }>();
	const record = stored && parseDevicePairingRecord(stored.value);
	if (!stored || !record || record.expiresAt <= Date.now()) return invalid();
	if (record.redeemed) {
		const token = await db.prepare("SELECT 1 FROM auth_tokens WHERE id = ? AND token_hash = ? AND device_id = ? AND scope = 'vault'").bind(record.id, body.tokenHash, deviceId).first();
		return record.redeemed === body.tokenHash && token ? redeemed(record) : invalid();
	}
	const limited = await limitNotificationAction(request, db, `device-pairing:${key}`);
	if (limited) return limited;
	// The exact unclaimed record and the current reset generation authorize one token.
	// An encryption reset replaces every credential, so a code issued before it is void.
	const grant = `EXISTS (SELECT 1 FROM maintenance_state WHERE key = ? AND value = ?
		AND json_extract(value, '$.resetGeneration') = COALESCE((SELECT reset_generation FROM server_state WHERE id = 1), ''))`;
	const created = 'EXISTS (SELECT 1 FROM auth_tokens WHERE id = ? AND token_hash = ?)';
	// Re-pairing a device replaces its previous credential and what that credential owned.
	const previous = "SELECT id FROM auth_tokens WHERE device_id = ? AND scope = 'vault' AND id != ?";
	const results = await db.batch([
		db.prepare(`INSERT INTO auth_tokens (id, token_hash, device_id, device_name, platform, scope, last_seen_at)
			SELECT ?, ?, ?, ?, ?, 'vault', datetime('now') WHERE ${grant}`)
			.bind(record.id, body.tokenHash, deviceId, deviceName, platform, key, stored.value),
		db.prepare(`DELETE FROM push_subscriptions WHERE owner_token_id IN (${previous}) AND ${created}`).bind(deviceId, record.id, record.id, body.tokenHash),
		db.prepare(`DELETE FROM auth_tokens WHERE scope = 'reading_capture' AND device_id IN (${previous}) AND ${created}`).bind(deviceId, record.id, record.id, body.tokenHash),
		db.prepare(`DELETE FROM auth_tokens WHERE id IN (${previous}) AND ${created}`).bind(deviceId, record.id, record.id, body.tokenHash),
		db.prepare(`UPDATE maintenance_state SET value = ?, updated_at = datetime('now') WHERE key = ? AND value = ? AND ${created}`)
			.bind(JSON.stringify({ ...record, redeemed: body.tokenHash }), key, stored.value, record.id, body.tokenHash),
	]);
	return changedRows(results[0]) === 1 ? redeemed(record) : invalid();
}

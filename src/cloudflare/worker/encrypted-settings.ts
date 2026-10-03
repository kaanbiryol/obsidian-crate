import { MAX_ENCRYPTED_SETTINGS_REQUEST_BYTES, validateEncryptedSettings } from '../../encryption/settings-format';
import { readEncryptionState, encryptionWriteGuard } from './encryption-state';
import { corsResponse } from './cors';
import { parseJsonObject } from './utils';
import { changedRows } from './db';

export const ENCRYPTED_SETTINGS_KEY = 'e2ee:settings';

export async function handleEncryptedSettings(request: Request, db: D1Database): Promise<Response | null> {
	const state = await readEncryptionState(db);
	if (!state) return null;
	if (request.method === 'GET') {
		const row = await db.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(ENCRYPTED_SETTINGS_KEY).first<{ value: string }>();
		return corsResponse(row ? JSON.parse(row.value) : { settings: null, settingsVersion: null });
	}
	if (request.method !== 'PUT') return null;
	const parsed = await parseJsonObject(request, MAX_ENCRYPTED_SETTINGS_REQUEST_BYTES);
	if (!parsed.ok) return parsed.response;
	const { settings, expectedVersion } = parsed.value;
	try { validateEncryptedSettings(settings); }
	catch { return corsResponse({ error: 'Encrypted shared settings are required' }, 400); }
	if (settings.vaultId !== state.vaultId || settings.keyId !== state.keyId) return corsResponse({ error: 'Shared settings use the wrong encryption key' }, 409);
	if (expectedVersion !== null && (typeof expectedVersion !== 'string' || expectedVersion.length > 128)) return corsResponse({ error: 'Invalid shared settings revision' }, 400);
	const guard = encryptionWriteGuard(state);
	const settingsVersion = crypto.randomUUID();
	const result = await db.prepare(`INSERT INTO maintenance_state (key, value, updated_at)
		SELECT ?, ?, datetime('now') WHERE ${guard.sql} AND (
			(? IS NULL AND NOT EXISTS (SELECT 1 FROM maintenance_state WHERE key = ?))
			OR EXISTS (SELECT 1 FROM maintenance_state WHERE key = ? AND json_extract(value, '$.settingsVersion') = ?))
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
		.bind(ENCRYPTED_SETTINGS_KEY, JSON.stringify({ settings, settingsVersion }), ...guard.args,
			expectedVersion, ENCRYPTED_SETTINGS_KEY, ENCRYPTED_SETTINGS_KEY, expectedVersion).run();
	return changedRows(result) === 1 ? corsResponse({ success: true, settingsVersion })
		: corsResponse({ error: 'Shared settings changed on another device' }, 409);
}

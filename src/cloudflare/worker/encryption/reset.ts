import { LAST_SEQ_SQL } from '../sync/storage';
import type { Env } from '../types';
import type { AuthPrincipal } from '../auth/authenticate';
import { corsResponse } from '../http/cors';
import { parseJsonObject } from '../http/request-validation';
import { hasEncryptionAuthority, readEncryptionState, saveEncryptionState } from './state';
import { DEPLOYMENT_FENCE_KEY, UPGRADE_PROGRESS_KEY } from '../../../protocol/deployment-fence';
import { isEncryptionId } from '../../../encryption/encoding';
import { validateEncryptionState, type EncryptionServerState, type ResetReceipt } from '../../../encryption/server-state';
import { isSha256Hex } from '../../../platform/validation';
import { sha256Hex } from '../../../platform/sha256';
import { putMaintenanceValue, readMaintenanceValue } from '../d1/db';
import { saveServerState } from '../d1/server-state';
import { R2_KEYS_PER_CALL } from '../d1/platform-limits';
import { ENCRYPTION_RESET_TABLES, READING_TABLES } from './reset-tables';

const PREFIX = 'encryption-reset:';
// Marks a reset that turns encryption on: completion activates the saved state instead of removing it.
const SETUP_SUFFIX = ':setup';
const save = (db: D1Database, key: string, value: unknown) => putMaintenanceValue(db, key, JSON.stringify(value));

/** Runs under the projection coordinator lock. The replacement credential and
 * reset receipt commit together, so a lost begin reply is safe to retry. The same
 * wipe turns encryption off (an active vault) or on (a plaintext vault given its new state). */
/** An upgrade backup between starting and completing; a completed one is released with
 * its write guards. */
async function upgradeBackupInProgress(db: D1Database): Promise<boolean> {
	const value = await readMaintenanceValue(db, UPGRADE_PROGRESS_KEY);
	if (value === null) return false;
	try { return (JSON.parse(value) as { phase?: unknown }).phase !== 'complete'; }
	catch { return true; }
}

export async function handleEncryptionReset(request: Request, env: Env, principal: AuthPrincipal): Promise<Response> {
	const id = new URL(request.url).searchParams.get('id');
	if (!isEncryptionId(id)) return corsResponse({ error: 'Invalid reset ID' }, 400);
	const value = await readMaintenanceValue(env.DB, PREFIX + id);
	const receipt = value !== null ? JSON.parse(value) as ResetReceipt : null;
	if (receipt) {
		if (principal.tokenId !== id) return corsResponse({ error: 'Resume from the device that started this reset' }, 403);
		if (request.method === 'GET' || receipt.complete) return corsResponse(receipt);
		if (request.method !== 'POST') return corsResponse({ error: 'Method not allowed' }, 405);
		return advanceReset(env, receipt);
	}
	if (request.method === 'GET') return corsResponse({ error: 'Reset has not started' }, 404);
	if (request.method !== 'POST') return corsResponse({ error: 'Method not allowed' }, 405);
	const current = await readEncryptionState(env.DB);
	if (current && current.mode !== 'active') return corsResponse({ error: 'Finish the current encryption reset first' }, 409);
	// A reset deletes every R2 object, including the files an upgrade backup is copying,
	// and the backup's write guards would then block the reset from finishing.
	if (await upgradeBackupInProgress(env.DB)) return corsResponse({ error: 'Finish the server update first, then try again.' }, 409);
	if (current && !hasEncryptionAuthority(request, current)) return corsResponse({ error: 'Unlock this vault before resetting it' }, 428);
	const parsed = await parseJsonObject(request, 512 * 1024);
	if (!parsed.ok) return parsed.response;
	const { replacementToken, confirmation, encryption } = parsed.value;
	if (confirmation !== 'delete-remote-data' || !isSha256Hex(replacementToken)) {
		return corsResponse({ error: 'Explicit data-loss confirmation and a new device credential are required' }, 400);
	}
	let state: EncryptionServerState;
	if (current) {
		if (encryption !== undefined) return corsResponse({ error: 'This vault is already encrypted' }, 409);
		state = current;
	} else {
		try { validateEncryptionState(encryption); } catch { return corsResponse({ error: 'A valid encrypted vault configuration is required' }, 400); }
		if (encryption.mode !== 'active') return corsResponse({ error: 'A valid encrypted vault configuration is required' }, 400);
		state = encryption;
		// The wipe cannot keep links the server is still downloading or an unfinished first sync.
		if (await env.DB.prepare('SELECT 1 FROM reading_captures LIMIT 1').first()) return corsResponse({ error: 'Wait for saved links to finish downloading, then turn on encryption.' }, 409);
		if (await env.DB.prepare("SELECT 1 FROM server_state WHERE id = 1 AND import_state = 'importing'").first()) return corsResponse({ error: 'Finish the initial sync before enabling encryption' }, 409);
	}
	const next: ResetReceipt = { id, vaultId: state.vaultId, generation: state.generation, complete: false };
	await env.DB.batch([
		save(env.DB, PREFIX + id, next),
		...(current ? [] : [save(env.DB, PREFIX + id + SETUP_SUFFIX, true)]),
		saveEncryptionState(env.DB, { ...state, mode: 'resetting' }),
		saveServerState(env.DB, 'reset_generation', id),
		env.DB.prepare(`INSERT INTO auth_tokens(id, token_hash, device_id, device_name, platform, scope)
			SELECT ?, ?, device_id, device_name, platform, 'vault' FROM auth_tokens WHERE id = ?`)
			.bind(id, await sha256Hex(replacementToken), principal.tokenId),
		env.DB.prepare('DELETE FROM auth_tokens WHERE id != ?').bind(id),
		// Every enrollment link, Reading code, save link and pairing.
		env.DB.prepare('DELETE FROM grants'),
		env.DB.prepare('DELETE FROM push_subscriptions'),
		// The shared settings belong to the old mode and keys.
		env.DB.prepare('UPDATE server_state SET settings = NULL, settings_version = NULL WHERE id = 1'),
		// Invalidate the Reading generation and receipts in the same transaction as
		// device revocation. Late extraction cannot publish into a replacement policy.
		...READING_TABLES.map(table => env.DB.prepare(`DELETE FROM ${table}`)),
		env.DB.prepare("DELETE FROM operations WHERE kind = 'reading'"),
		env.DB.prepare("DELETE FROM operation_chunks WHERE kind = 'reading'"),
		// Unschedule every reminder in the same transaction, so the dispatcher sends nothing
		// more. Completion later deletes the rows with the other reminder tables.
		env.DB.prepare('UPDATE reminder_projections SET due_at = NULL WHERE due_at IS NOT NULL'),
		// Keep cleanup authority for an R2 put that finishes after the reset.
		env.DB.prepare("UPDATE upload_leases SET state = 'deleting'"),
	]);
	return corsResponse(next);
}

async function advanceReset(env: Env, receipt: ResetReceipt): Promise<Response> {
	const state = await readEncryptionState(env.DB);
	if (state?.mode !== 'resetting' || state.vaultId !== receipt.vaultId || state.generation !== receipt.generation) {
		return corsResponse({ error: 'The vault changed during reset. Stop and reconnect.' }, 409);
	}
	// Delete from the start each time. No cursor can skip objects after deletion,
	// and a timeout after R2 deletion simply retries the remaining page.
	const objects = await env.BUCKET.list({ limit: R2_KEYS_PER_CALL });
	if (objects.objects.length) {
		await env.BUCKET.delete(objects.objects.map(object => object.key));
		return corsResponse(receipt);
	}
	const complete = { ...receipt, complete: true };
	const setup = await env.DB.prepare('SELECT 1 FROM maintenance_state WHERE key = ?').bind(PREFIX + receipt.id + SETUP_SUFFIX).first();
	await env.DB.batch([
		// Sequence numbers keep rising after the changelog and import snapshot are emptied.
		env.DB.prepare(`UPDATE server_state SET changelog_floor = ${LAST_SEQ_SQL} WHERE id = 1`),
		...ENCRYPTION_RESET_TABLES.wiped.map(table => env.DB.prepare(`DELETE FROM ${table}`)),
		env.DB.prepare('DELETE FROM auth_tokens WHERE id != ?').bind(receipt.id),
		env.DB.prepare('DELETE FROM maintenance_state WHERE key != ? AND key NOT LIKE ?')
			.bind(DEPLOYMENT_FENCE_KEY, PREFIX + '%'),
		// Keep reset authority even after the vault returns to plaintext mode; features return to
		// their defaults and the initial import to none.
		env.DB.prepare(`UPDATE server_state SET encryption = ?, features = NULL, import_token = NULL, import_state = NULL,
			import_generation = 0, import_snapshot_seq = 0, settings = NULL, settings_version = NULL, file_count = 0 WHERE id = 1`)
			.bind(setup ? JSON.stringify({ ...state, mode: 'active' }) : null),
		save(env.DB, PREFIX + receipt.id, complete),
	]);
	return corsResponse(complete);
}

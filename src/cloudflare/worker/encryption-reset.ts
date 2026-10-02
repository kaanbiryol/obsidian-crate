import type { Env } from './types';
import type { AuthPrincipal } from './authenticate';
import { sha256Hex } from './auth';
import { corsResponse } from './cors';
import { parseJsonObject } from './utils';
import { ENCRYPTION_STATE_KEY, readEncryptionState } from './encryption-state';
import { DEPLOYMENT_FENCE_KEY } from '../deployment-fence';
import { isEncryptionId } from '../../encryption/encoding';
import { SYNC_RESET_GENERATION_KEY } from './sync-reset-generation';

const PREFIX = 'encryption-reset:';
const READING_TABLES = ['reading_policy', 'reading_sources', 'reading_jobs', 'reading_operations',
	'reading_enrollments', 'reading_handoffs', 'reading_captures'] as const;
interface ResetReceipt { id: string; vaultId: string; generation: number; complete: boolean }
const save = (db: D1Database, key: string, value: unknown) => db.prepare(`INSERT INTO maintenance_state(key, value) VALUES (?, ?)
	ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(key, JSON.stringify(value));

/** Runs under the projection coordinator lock. The replacement credential and
 * reset receipt commit together, so a lost begin reply is safe to retry. */
export async function handleEncryptionReset(request: Request, env: Env, path: string, principal: AuthPrincipal): Promise<Response | null> {
	if (path !== '/encryption/reset' || principal.scope !== 'vault') return null;
	const id = new URL(request.url).searchParams.get('id');
	if (!isEncryptionId(id)) return corsResponse({ error: 'Invalid reset ID' }, 400);
	const row = await env.DB.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(PREFIX + id).first<{ value: string }>();
	const receipt = row ? JSON.parse(row.value) as ResetReceipt : null;
	if (receipt) {
		if (principal.tokenId !== id) return corsResponse({ error: 'Resume from the device that started this reset' }, 403);
		if (request.method === 'GET' || receipt.complete) return corsResponse(receipt);
		if (request.method !== 'POST') return corsResponse({ error: 'Method not allowed' }, 405);
		return advanceReset(env, receipt);
	}
	if (request.method === 'GET') return corsResponse({ error: 'Reset has not started' }, 404);
	if (request.method !== 'POST') return corsResponse({ error: 'Method not allowed' }, 405);
	const state = await readEncryptionState(env.DB);
	if (!state || state.mode !== 'active') return corsResponse({ error: 'An active encrypted vault is required to start this reset' }, 409);
	if (request.headers.get('X-Crate-Encryption-Vault') !== state.vaultId
		|| request.headers.get('X-Crate-Encryption-Generation') !== String(state.generation)) return corsResponse({ error: 'Unlock this vault before resetting it' }, 428);
	const parsed = await parseJsonObject(request, 2048);
	if (!parsed.ok) return parsed.response;
	const { replacementToken, confirmation } = parsed.value;
	if (confirmation !== 'delete-remote-data' || typeof replacementToken !== 'string' || !/^[a-f0-9]{64}$/.test(replacementToken)) {
		return corsResponse({ error: 'Explicit data-loss confirmation and a new device credential are required' }, 400);
	}
	const next: ResetReceipt = { id, vaultId: state.vaultId, generation: state.generation, complete: false };
	await env.DB.batch([
		save(env.DB, PREFIX + id, next),
		save(env.DB, ENCRYPTION_STATE_KEY, { ...state, mode: 'resetting' }),
		env.DB.prepare(`INSERT INTO maintenance_state(key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(SYNC_RESET_GENERATION_KEY, id),
		env.DB.prepare(`INSERT INTO auth_tokens(id, token_hash, device_id, device_name, platform, scope)
			SELECT ?, ?, device_id, device_name, platform, 'vault' FROM auth_tokens WHERE id = ?`)
			.bind(id, await sha256Hex(replacementToken), principal.tokenId),
		env.DB.prepare('DELETE FROM auth_tokens WHERE id != ?').bind(id),
		env.DB.prepare('DELETE FROM web_enrollment_tokens'),
		env.DB.prepare('DELETE FROM push_subscriptions'),
		// Invalidate the Reading generation and grants in the same transaction as
		// device revocation. Late extraction cannot publish into a replacement policy.
		...READING_TABLES.map(table => env.DB.prepare(`DELETE FROM ${table}`)),
		env.DB.prepare(`INSERT INTO notification_jobs(reminder_id, job_token, operation, available_at)
			SELECT reminder_id, lower(hex(randomblob(16))), 'cancel', 0 FROM scheduled_reminders WHERE 1
			ON CONFLICT(reminder_id) DO UPDATE SET operation = 'cancel', job_token = excluded.job_token, payload_json = NULL, available_at = 0`),
		env.DB.prepare("UPDATE notification_jobs SET operation = 'cancel', payload_json = NULL, available_at = 0"),
		// Keep cleanup authority for an R2 put that finishes after the reset.
		env.DB.prepare("UPDATE staged_uploads SET state = 'deleting'"),
		env.DB.prepare("UPDATE staged_upload_batches SET state = 'deleting'"),
	]);
	return corsResponse(next);
}

async function advanceReset(env: Env, receipt: ResetReceipt): Promise<Response> {
	const state = await readEncryptionState(env.DB);
	if (state?.mode !== 'resetting' || state.vaultId !== receipt.vaultId || state.generation !== receipt.generation) {
		return corsResponse({ error: 'The vault changed during reset. Stop and reconnect.' }, 409);
	}
	await env.DB.prepare("UPDATE notification_jobs SET available_at = 0 WHERE operation = 'cancel'").run();
	const dispatcher = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/notification-dispatch'));
	if (!(await dispatcher.fetch('https://do/dispatch-jobs', { method: 'POST' })).ok) throw new Error('Could not cancel previous notification schedules');
	if (await env.DB.prepare('SELECT 1 FROM notification_jobs UNION SELECT 1 FROM scheduled_reminders LIMIT 1').first()) return corsResponse(receipt);
	// Delete from the start each time. No cursor can skip objects after deletion,
	// and a timeout after R2 deletion simply retries the remaining page.
	const objects = await env.BUCKET.list({ limit: 100 });
	if (objects.objects.length) {
		await env.BUCKET.delete(objects.objects.map(object => object.key));
		return corsResponse(receipt);
	}
	const complete = { ...receipt, complete: true };
	await env.DB.batch([
		...['files', 'file_versions', 'changelog', 'file_deletion_receipts', 'upload_operations', 'reminder_operations',
			'reminder_file_cache', 'reminder_identities', 'reminder_occurrences', 'reminder_sources', 'reminder_source_state',
			'reminder_projections', 'notification_projection_jobs', 'notification_file_retries', 'notification_policy', 'initial_import',
			'web_enrollment_tokens', 'push_subscriptions', ...READING_TABLES].map(table => env.DB.prepare(`DELETE FROM ${table}`)),
		env.DB.prepare('DELETE FROM auth_tokens WHERE id != ?').bind(receipt.id),
		// Preserve reset authority even after the vault returns to plaintext mode.
		env.DB.prepare('DELETE FROM maintenance_state WHERE key NOT IN (?, ?) AND key NOT LIKE ?')
			.bind(DEPLOYMENT_FENCE_KEY, SYNC_RESET_GENERATION_KEY, PREFIX + '%'),
		save(env.DB, PREFIX + receipt.id, complete),
	]);
	return corsResponse(complete);
}

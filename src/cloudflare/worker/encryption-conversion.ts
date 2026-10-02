import { convertedCapturePath, convertReadingCapture } from './encryption-conversion-reading';
import { isReadingScopeExtension, isEncryptionScopeMove, validateEncryptionState, type EncryptionServerState } from '../../encryption/server-state';
import { prepareEncryptionScopeMove } from './encryption-scope-move';
import { MAX_ENCRYPTED_SETTINGS_REQUEST_BYTES, MAX_SHARED_SETTINGS_BYTES, validateEncryptedSettings } from '../../encryption/settings-format';
import { ENCRYPTION_STATE_KEY, ENCRYPTION_FILE_PREFIX, readEncryptionState } from './encryption-state';
import { ENCRYPTED_SETTINGS_KEY } from './encrypted-settings';
import { CONVERSION_FILES, convertFile } from './encryption-conversion-objects';
import { corsResponse } from './cors';
import { parseJsonObject } from './utils';
import { MAX_CONVERTED_RECEIPT_BYTES, isReceiptEnvelope } from '../../encryption/receipt-format';
import { isEncryptionId } from '../../encryption/encoding';
import { prepareEncryptedReceipt } from './encrypted-receipt-storage';
import type { Env } from './types';

const putValue = (env: Env, key: string, value: unknown) => env.DB.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, JSON.stringify(value));


/** All conversion writes run under the projection coordinator's mutation lock.
 * No private key is accepted here. Activation is the final, guarded transition. */
export async function handleEncryptionConversion(request: Request, env: Env, path: string): Promise<Response | null> {
	if (!path.startsWith('/encryption/conversion')) return null;
	const state = await readEncryptionState(env.DB);
	if (state?.mode === 'resetting') return corsResponse({ error: 'Resume the encryption reset before making other changes' }, 423);
	if (path === '/encryption/conversion' && request.method === 'POST') {
		const body = await parseJsonObject(request, 512 * 1024);
		if (!body.ok) return body.response;
		try { validateEncryptionState(body.value); } catch { return corsResponse({ error: 'Invalid encrypted vault configuration' }, 400); }
		const configuration = body.value;
		if (body.value.mode !== 'converting') return corsResponse({ error: 'Start with a conversion configuration' }, 400);
		const extendingReading = state && isReadingScopeExtension(state, configuration);
		const movingScopes = state && isEncryptionScopeMove(state, configuration);
		if (state && !extendingReading && !movingScopes) return JSON.stringify(state) === JSON.stringify(body.value) ? corsResponse({ encryption: state }) : corsResponse({ error: 'This vault already has a different encryption configuration. Recover its keys first.' }, 409);
		// Reject unsupported legacy data before freezing sync. All settings accepted
		// by the plaintext API fit the encrypted envelope and request limits.
		const settings = await env.BUCKET.head('__crate__/settings.json');
		if (settings && settings.size > MAX_SHARED_SETTINGS_BYTES) return corsResponse({ error: 'Shared settings are too large to encrypt. Reduce exclusion patterns before enabling encryption.' }, 413);
		if (await env.DB.prepare("SELECT 1 FROM initial_import WHERE state = 'importing'").first()) return corsResponse({ error: 'Finish the initial sync before enabling encryption' }, 409);
		const folders = await env.DB.prepare(`SELECT folder_path FROM reading_policy UNION SELECT folder_path FROM notification_policy UNION SELECT folder_path FROM auth_tokens WHERE scope = 'reminders' AND (expires_at IS NULL OR expires_at > ?) UNION SELECT folder_path FROM web_enrollment_tokens WHERE expires_at > ?`).bind(Date.now(), Date.now()).all<{ folder_path: string | null }>();
		if (!movingScopes && folders.results.some(row => row.folder_path && !configuration.scopes.some(scope => scope.folderPath === row.folder_path))) return corsResponse({ error: 'Include every enrolled reminders folder before enabling encryption' }, 409);
		const added = extendingReading ? configuration.scopes.find(scope => !state.scopes.some(old => old.id === scope.id))! : null;
    const affected = added ? [added.folderPath] : movingScopes ? state.scopes.flatMap(scope => {
      const target = configuration.scopes.find(candidate => candidate.id === scope.id)!;
      return target.folderPath === scope.folderPath ? [] : [scope.folderPath, target.folderPath];
    }) : [];
    const scopeVersions = `SELECT f.revision FROM (${CONVERSION_FILES}) f WHERE EXISTS
      (SELECT 1 FROM json_each(?) WHERE f.path >= value || '/' AND f.path < value || '0')`;
    await env.DB.batch([
      ...(affected.length ? [
        env.DB.prepare(`INSERT INTO maintenance_state(key,value) SELECT 'e2ee:prior-file:' || f.revision, m.value FROM (${CONVERSION_FILES}) f JOIN maintenance_state m ON m.key = ? || f.revision WHERE f.revision IN (${scopeVersions})`).bind(ENCRYPTION_FILE_PREFIX, JSON.stringify(affected)),
        env.DB.prepare(`DELETE FROM maintenance_state WHERE key IN (SELECT ? || revision FROM (${scopeVersions}))`).bind(ENCRYPTION_FILE_PREFIX, JSON.stringify(affected)),
        env.DB.prepare("DELETE FROM maintenance_state WHERE key = 'e2ee:cleanup-cursor'"),
      ] : []),
			...(movingScopes ? prepareEncryptionScopeMove(env.DB, state, configuration) : []),
			putValue(env, ENCRYPTION_STATE_KEY, body.value),
			// Freeze alarms before any plaintext content is removed. The cancellation
			// queue is drained explicitly before activation, including DO storage.
			env.DB.prepare(`INSERT INTO notification_jobs(reminder_id, job_token, operation, available_at)
				SELECT reminder_id, lower(hex(randomblob(16))), 'cancel', 0 FROM scheduled_reminders WHERE 1
				ON CONFLICT(reminder_id) DO UPDATE SET operation = 'cancel', job_token = excluded.job_token, payload_json = NULL, available_at = 0`),
			env.DB.prepare("UPDATE notification_jobs SET operation = 'cancel', payload_json = NULL, available_at = 0"),
		]);
		return corsResponse({ encryption: body.value });
	}
	if (!state) return corsResponse({ error: 'Start encryption conversion first' }, 409);
	if (request.headers.get('X-Crate-Encryption-Vault') !== state.vaultId || request.headers.get('X-Crate-Encryption-Generation') !== String(state.generation)) return corsResponse({ error: 'Recover the conversion keys before continuing' }, 428);
	if (state.mode === 'active') return path === '/encryption/conversion/finish' ? corsResponse({ encryption: state }) : corsResponse({ error: 'Encryption conversion is already complete' }, 409);
	if (path === '/encryption/conversion/reading-capture' && request.method === 'PUT') return convertReadingCapture(request, env, state);
	if (path === '/encryption/conversion/file') return convertFile(request, env, state);
	if (path === '/encryption/conversion' && request.method === 'GET') {
		// Read once per conversion/resume, rather than scanning the inventory on every page.
		const counts = new URL(request.url).searchParams.get('includeProgress') === '1'
			? await env.DB.prepare(`SELECT COUNT(*) AS remainingFiles FROM (${CONVERSION_FILES}) f WHERE NOT EXISTS (SELECT 1 FROM maintenance_state WHERE key = ? || f.revision)`).bind(ENCRYPTION_FILE_PREFIX).first<{ remainingFiles: number }>() : null;
		const files = await env.DB.prepare(`SELECT f.*, (SELECT value FROM maintenance_state WHERE key = 'e2ee:prior-file:' || f.revision) AS previous_descriptor FROM (${CONVERSION_FILES}) f WHERE NOT EXISTS (SELECT 1 FROM maintenance_state WHERE key = ? || f.revision) ORDER BY revision LIMIT 25`).bind(ENCRYPTION_FILE_PREFIX).all();
		const receipts = await env.DB.prepare("SELECT operation_id, request_hash, response_json FROM reminder_operations WHERE json_type(response_json, '$.e2eeLegacy') IS NULL ORDER BY operation_id LIMIT 25").all();
		const uploads = await env.DB.prepare("SELECT operation_id, request_hash, response_json FROM upload_operations WHERE json_type(response_json, '$.e2eeLegacy') IS NULL ORDER BY operation_id LIMIT 25").all();
		const folders = await env.DB.prepare("SELECT folder_path FROM auth_tokens WHERE scope = 'reminders' UNION SELECT folder_path FROM notification_policy").all();
		const reading = await env.DB.prepare("SELECT operation_id, request_hash, response_json FROM reading_operations WHERE json_type(response_json, '$.e2eeLegacy') IS NULL ORDER BY operation_id LIMIT 25").all();
		const captures = await env.DB.prepare('SELECT c.id, c.note, p.folder_path FROM reading_captures c JOIN reading_policy p ON c.generation=p.generation LIMIT 25').all<{ id: string; note: string; folder_path: string }>();
		return corsResponse({ ...(counts ?? {}), reading: reading.results, captures: captures.results.map(c => ({ id: c.id, note: c.note, path: convertedCapturePath(c.folder_path, c.id) })), files: files.results, receipts: receipts.results, uploads: uploads.results, folders: folders.results });
	}
	if (path === '/encryption/conversion/settings') {
		if (request.method === 'GET') {
			if (await env.DB.prepare('SELECT 1 FROM maintenance_state WHERE key = ?').bind(ENCRYPTED_SETTINGS_KEY).first()) return corsResponse({ converted: true });
			const object = await env.BUCKET.get('__crate__/settings.json');
			return corsResponse({ settings: object ? JSON.parse(await object.text()) as unknown : null });
		}
		if (request.method === 'PUT') {
			const body = await parseJsonObject(request, MAX_ENCRYPTED_SETTINGS_REQUEST_BYTES); if (!body.ok) return body.response;
			try { validateEncryptedSettings(body.value); } catch { return corsResponse({ error: 'Encrypted shared settings required' }, 400); }
			if (body.value.vaultId !== state.vaultId || body.value.keyId !== state.keyId) return corsResponse({ error: 'Settings use a different key' }, 409);
			await env.DB.batch([putValue(env, ENCRYPTED_SETTINGS_KEY, { settings: body.value, settingsVersion: crypto.randomUUID() }), putValue(env, 'e2ee:settings-converted', true)]);
			// Final cleanup also retries deletion after an interrupted response.
			await env.BUCKET.delete('__crate__/settings.json');
			return corsResponse({ success: true });
		}
	}
	if (path === '/encryption/conversion/receipt' && request.method === 'PUT') {
		const body = await parseJsonObject(request, MAX_CONVERTED_RECEIPT_BYTES); if (!body.ok) return body.response;
		const { operationId, vault, scopes, kind = 'reminder' } = body.value;
		if (kind !== 'reminder' && kind !== 'upload' && kind !== 'reading') return corsResponse({ error: 'Invalid receipt kind' }, 400);
		if (!isEncryptionId(operationId) || !isReceiptEnvelope(vault) || !Array.isArray(scopes) || scopes.length > state.scopes.length
			|| scopes.some((item: unknown) => !item || typeof item !== 'object' || !('id' in item) || !('envelope' in item) || !isReceiptEnvelope(item.envelope) || !state.scopes.some(scope => scope.id === item.id))) return corsResponse({ error: 'Invalid encrypted receipt' }, 400);
		const table = kind === 'upload' ? 'upload_operations' : kind === 'reading' ? 'reading_operations' : 'reminder_operations';
		const predicate = "operation_id = ? AND json_type(response_json, '$.e2eeLegacy') IS NULL";
		const receipt = prepareEncryptedReceipt(env.DB, kind, operationId, { e2eeLegacy: { vault, scopes } },
			{ sql: `EXISTS (SELECT 1 FROM ${table} WHERE ${predicate})`, args: [operationId] });
		await env.DB.batch([...receipt.statements, env.DB.prepare(`UPDATE ${table} SET request_hash = 'e2ee-legacy', response_json = ? WHERE ${predicate}`)
			.bind(receipt.json, operationId)]);
		return corsResponse({ success: true });
	}
	if (path === '/encryption/conversion/checkpoints') {
		const cursor = new URL(request.url).searchParams.get('cursor') ?? undefined;
		const listing = await env.BUCKET.list({ prefix: '__crate__/history/checkpoints/', limit: 20, ...(cursor ? { cursor } : {}) });
		const documents = [];
		for (const item of listing.objects) {
			const object = await env.BUCKET.get(item.key); if (!object || object.size > 12 * 1024 * 1024) throw new Error('Checkpoint is unavailable');
			const document: unknown = JSON.parse(await object.text());
			if (!document || typeof document !== 'object') throw new Error('Checkpoint is invalid');
			if (!('encrypted' in document)) documents.push({ key: item.key, document });
		}
		return corsResponse({ documents, cursor: listing.truncated ? listing.cursor : null });
	}
	if (path === '/encryption/conversion/checkpoint' && request.method === 'PUT') {
		const body = await parseJsonObject(request, 12 * 1024 * 1024); if (!body.ok) return body.response;
		const { key, encrypted } = body.value;
		if (typeof key !== 'string' || !/^__crate__\/history\/checkpoints\/[a-f0-9-]{36}\.json$/.test(key) || typeof encrypted !== 'string' || encrypted.length > 12 * 1024 * 1024 || encrypted.split('.').length !== 5) return corsResponse({ error: 'Invalid encrypted checkpoint' }, 400);
		const object = await env.BUCKET.get(key); if (!object) return corsResponse({ error: 'Checkpoint is unavailable' }, 404);
		const previous = JSON.parse(await object.text()) as { checkpoint: unknown; encrypted?: string };
		if (!previous.encrypted) await env.BUCKET.put(key, JSON.stringify({ version: 1, checkpoint: previous.checkpoint, encrypted }), { httpMetadata: { contentType: 'application/json' } });
		return corsResponse({ success: true });
	}
	if (path === '/encryption/conversion/finish' && request.method === 'POST') return finishConversion(env, state);
	return corsResponse({ error: 'Unknown encryption conversion operation' }, 404);
}

async function finishConversion(env: Env, state: EncryptionServerState): Promise<Response> {
	const unfinished = await env.DB.prepare(`SELECT 1 WHERE EXISTS (SELECT 1 FROM (${CONVERSION_FILES}) f WHERE NOT EXISTS (SELECT 1 FROM maintenance_state WHERE key = ? || f.revision))
    OR EXISTS (SELECT 1 FROM reading_captures)
    OR EXISTS (SELECT 1 FROM reading_operations WHERE json_type(response_json, '$.e2eeLegacy') IS NULL)
    OR EXISTS (SELECT 1 FROM reminder_operations WHERE json_type(response_json, '$.e2eeLegacy') IS NULL)
    OR EXISTS (SELECT 1 FROM upload_operations WHERE json_type(response_json, '$.e2eeLegacy') IS NULL)
    OR NOT EXISTS (SELECT 1 FROM maintenance_state WHERE key = 'e2ee:settings-converted')`).bind(ENCRYPTION_FILE_PREFIX).first();
  if (unfinished) return corsResponse({ error: 'Finish converting files, Reading captures, settings and saved responses first' }, 409);
	// The dispatch DO drains cancellation jobs in bounded batches. A lost reply is
	// harmless: cancellation is token-checked and removes its private DO state.
	await env.DB.prepare("UPDATE notification_jobs SET available_at = 0 WHERE operation = 'cancel'").run();
	const dispatcher = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/notification-dispatch'));
	const dispatched = await dispatcher.fetch('https://do/dispatch-jobs', { method: 'POST' });
	if (!dispatched.ok) throw new Error('Could not cancel old plaintext notification schedules');
	if (await env.DB.prepare('SELECT 1 FROM notification_jobs UNION SELECT 1 FROM scheduled_reminders LIMIT 1').first()) return corsResponse({ pending: true });
	// Sweep every owned R2 object in bounded pages before activation. Checkpoints
	// must already be encrypted. Unreferenced staged/retired content is disposable.
	const cursor = (await env.DB.prepare("SELECT value FROM maintenance_state WHERE key = 'e2ee:cleanup-cursor'").first<{ value: string }>())?.value;
	const listing = await env.BUCKET.list({ limit: 100, ...(cursor ? { cursor: JSON.parse(cursor) as string } : {}) });
	const managedKeys = listing.objects.map(object => object.key)
		.filter(key => key.startsWith('__crate__/files/') || key === '__crate__/settings.json');
	// Bound queries independently of page size; per-object lookups can exhaust
	// the request budget before a full page advances its cleanup cursor.
	const references = managedKeys.length ? await env.DB.prepare(`
		SELECT storage_key FROM files WHERE storage_key IN (SELECT value FROM json_each(?))
		UNION SELECT storage_key FROM file_versions WHERE storage_key IN (SELECT value FROM json_each(?))`)
		.bind(JSON.stringify(managedKeys), JSON.stringify(managedKeys)).all<{ storage_key: string }>() : null;
	const referenced = new Set(references?.results.map(row => row.storage_key));
	for (const object of listing.objects) {
		if (object.key.startsWith('__crate__/history/checkpoints/')) {
			const checkpoint = await env.BUCKET.get(object.key);
			if (!checkpoint || !('encrypted' in JSON.parse(await checkpoint.text()))) return corsResponse({ error: 'Convert every retained checkpoint before finishing' }, 409);
		}
	}
	const orphaned = managedKeys.filter(key => !referenced.has(key));
	if (orphaned.length) await env.BUCKET.delete(orphaned);
	if (listing.truncated) { await putValue(env, 'e2ee:cleanup-cursor', listing.cursor).run(); return corsResponse({ pending: true }); }
	const active: EncryptionServerState = { ...state, mode: 'active' };
	await env.DB.batch([
		...['reading_sources', 'reading_jobs', 'reading_handoffs', 'reading_enrollments', 'reminder_file_cache', 'reminder_projections', 'reminder_sources', 'reminder_source_state', 'notification_projection_jobs', 'notification_file_retries', 'file_deletion_receipts'].map(table => env.DB.prepare(`DELETE FROM ${table}`)),
		// Verification rows and their scan progress are one rebuildable state.
		// A retained completed cursor would otherwise skip every converted note.
		env.DB.prepare("DELETE FROM maintenance_state WHERE key LIKE 'reminder_source_scan_%' OR key LIKE 'e2ee:prior-file:%'"),
		// Keep old upload leases: a timed-out R2 put can become visible later.
		// Reference-aware maintenance must retain authority to reclaim it.
		// Drop old content fingerprints from obsolete changelog rows and force all
		// clients through a fresh inventory while retaining the sequence fence.
		env.DB.prepare("INSERT INTO initial_import(id, token, state, snapshot_seq) VALUES (1, lower(hex(randomblob(16))), 'complete', COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'changelog'), 0) + 1) ON CONFLICT(id) DO UPDATE SET snapshot_seq = excluded.snapshot_seq"),
		env.DB.prepare('DELETE FROM changelog'),
		env.DB.prepare("INSERT INTO sqlite_sequence(name, seq) SELECT 'changelog', snapshot_seq FROM initial_import WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'changelog')"),
		env.DB.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, (SELECT snapshot_seq FROM initial_import WHERE id = 1)) WHERE name = 'changelog'"),
		env.DB.prepare("INSERT INTO changelog(path, action, revision, hash, size) SELECT path, 'put', storage_key, hash, size FROM files"),
		env.DB.prepare("INSERT INTO notification_projection_jobs(path, job_token) SELECT path, lower(hex(randomblob(16))) FROM files WHERE lower(path) LIKE '%.md'"),
		putValue(env, ENCRYPTION_STATE_KEY, active),
	]);
	return corsResponse({ encryption: active });
}

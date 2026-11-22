import { LAST_SEQ_SQL } from '../storage';
import { INITIAL_IMPORT_VERIFY_PAGE, type ImportInventoryEntry, type InitialImport } from '@/protocol/initial-import';
import { queryRows, readMaintenanceValue } from '../../d1/db';
import { corsResponse } from '../../http/cors';
import { parseJsonObject } from '../../http/request-validation';
import { INITIAL_REMINDERS_PENDING } from './initial-import-readiness';
import { encryptionWriteGuard } from '../../encryption/state';
import type { EncryptionServerState } from '@/encryption/server-state';

const IMPORT_VERIFICATION_KEY = 'initial_import_verification';

export async function readInitialImport(db: D1Database): Promise<(InitialImport & { generation: number; snapshot_seq: number }) | null> {
	return db.prepare(`SELECT import_token AS token, import_state AS state, import_generation AS generation, import_snapshot_seq AS snapshot_seq
    FROM server_state WHERE id = 1 AND import_token IS NOT NULL`).first();
}

/** Only a never-populated remote can enter import mode, such as a plaintext vault before
 * its first sync or an encrypted one after the reset that turned encryption on. The
 * encryption state is the one the request was authenticated with. Repeated starts are
 * read-only. */
export async function beginInitialImport(db: D1Database, encryption: EncryptionServerState | null, wakeReminders?: () => Promise<void>): Promise<Response> {
	let current = await readInitialImport(db);
	if (!current) {
		const authority = encryptionWriteGuard(encryption);
		await db.prepare(`INSERT INTO server_state(id, import_token, import_state)
      SELECT 1, ?, 'importing' WHERE NOT EXISTS (SELECT 1 FROM files)
        AND NOT EXISTS (SELECT 1 FROM changelog) AND NOT EXISTS (SELECT 1 FROM file_versions)
        AND NOT EXISTS (SELECT 1 FROM operations WHERE kind = 'upload')
        AND ${authority.sql}
      ON CONFLICT(id) DO UPDATE SET import_token = excluded.import_token, import_state = excluded.import_state
        WHERE server_state.import_token IS NULL`).bind(crypto.randomUUID(), ...authority.args).run();
		current = await readInitialImport(db);
	}
	const preparing = current?.state === 'complete' && Boolean(await db.prepare('SELECT 1 FROM maintenance_state WHERE key = ? AND value = ?')
		.bind(INITIAL_REMINDERS_PENDING, current.token).first());
	if (preparing) await wakeReminders?.();
	return corsResponse({ import: current?.state === 'importing' || preparing ? current : null });
}

function parseInventoryEntries(value: unknown): ImportInventoryEntry[] | null {
	if (!Array.isArray(value) || value.length > INITIAL_IMPORT_VERIFY_PAGE) return null;
	return value.every(entry => Array.isArray(entry) && entry.length === 3 && typeof entry[0] === 'string'
		&& typeof entry[1] === 'string' && Number.isSafeInteger(entry[2])) ? value as ImportInventoryEntry[] : null;
}

/** Each request verifies the next primary-key range against the client's
 * inventory. Progress is bound to the import generation, so any upload or prune
 * between pages restarts verification. The final page also proves no extra rows. */
export async function finishInitialImport(request: Request, db: D1Database): Promise<Response> {
	const parsed = await parseJsonObject(request, 2 * 1024 * 1024);
	if (!parsed.ok) return parsed.response;
	const current = await readInitialImport(db);
	if (!current || current.token !== parsed.value.token) return corsResponse({ error: 'Unknown initial import' }, 409);
	if (current.state === 'complete') return corsResponse({ lastSeq: current.snapshot_seq });
	const { after, final } = parsed.value;
	const entries = parseInventoryEntries(parsed.value.entries);
	if (typeof after !== 'string' || typeof final !== 'boolean' || !entries || (!final && !entries.length)) return corsResponse({ error: 'Invalid initial import inventory' }, 400);
	// The files verified on earlier pages; the final page makes them the file count.
	let verified = 0;
	if (after) {
		const stored = await readMaintenanceValue(db, IMPORT_VERIFICATION_KEY);
		const progress = stored !== null ? JSON.parse(stored) as { token?: string; generation?: number; cursor?: string; verified?: number } : null;
		if (progress?.token !== current.token || progress.generation !== current.generation || progress.cursor !== after || !Number.isSafeInteger(progress.verified)) {
			return corsResponse({ error: 'Initial upload changed. Sync again to resume.' }, 409);
		}
		verified = progress.verified!;
	}
	const rows = await queryRows<{ path: string; portable_path: string; hash: string; size: number }>(db.prepare(
		'SELECT path, portable_path, hash, size FROM files WHERE portable_path > ? ORDER BY portable_path LIMIT ?').bind(after, entries.length + (final ? 1 : 0)));
	if (rows.length !== entries.length || rows.some((row, index) => {
		const [path, hash, size] = entries[index]!;
		return row.path !== path || row.hash !== hash || row.size !== size;
	})) {
		return corsResponse({ error: 'Initial upload is incomplete. Sync again to resume.' }, 409);
	}
	if (!final) {
		const cursor = rows.at(-1)!.portable_path;
		await db.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
			.bind(IMPORT_VERIFICATION_KEY, JSON.stringify({ token: current.token, generation: current.generation, cursor, verified: verified + rows.length })).run();
		return corsResponse({ cursor });
	}
	await db.batch([
		// Later changelog entries number from the snapshot (see LAST_SEQ_SQL). Imports keep no
		// file count, so the verified inventory sets it; commits keep it from then on.
		db.prepare(`UPDATE server_state SET import_state = 'complete', import_snapshot_seq = MAX(1, ${LAST_SEQ_SQL} + 1), file_count = ?
      WHERE id = 1 AND import_token = ? AND import_state = 'importing' AND import_generation = ?`).bind(verified + rows.length, current.token, current.generation),
		// Folder setup can finish an empty reminder scan before the first upload starts.
		db.prepare(`DELETE FROM maintenance_state WHERE key LIKE 'reminder_source_scan_%'
      AND EXISTS (SELECT 1 FROM server_state WHERE id = 1 AND import_state = 'complete')`),
		db.prepare(`INSERT INTO maintenance_state(key, value) SELECT ?, import_token FROM server_state
      WHERE id = 1 AND import_state = 'complete' AND EXISTS (SELECT 1 FROM notification_policy)
      ON CONFLICT(key) DO NOTHING`).bind(INITIAL_REMINDERS_PENDING),
		db.prepare('DELETE FROM maintenance_state WHERE key = ?').bind(IMPORT_VERIFICATION_KEY),
	]);
	const finished = await readInitialImport(db);
	if (finished?.state !== 'complete') return corsResponse({ error: 'Initial upload changed. Sync again to resume.' }, 409);
	return corsResponse({ lastSeq: finished.snapshot_seq });
}

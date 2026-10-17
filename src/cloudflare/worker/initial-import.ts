import { INITIAL_IMPORT_VERIFY_PAGE, type ImportInventoryEntry, type InitialImport } from '@/protocol/initial-import';
import { queryRows } from './db';
import { corsResponse } from './cors';
import { parseJsonObject } from './utils';
import { INITIAL_REMINDERS_PENDING } from './initial-import-readiness';

const IMPORT_VERIFICATION_KEY = 'initial_import_verification';

export async function readInitialImport(db: D1Database): Promise<(InitialImport & { generation: number; snapshot_seq: number }) | null> {
  return db.prepare('SELECT token, state, generation, snapshot_seq FROM initial_import WHERE id = 1').first();
}

/** Only a never-populated remote can enter import mode. Repeated starts are read-only. */
export async function beginInitialImport(db: D1Database, wakeReminders?: () => Promise<void>): Promise<Response> {
  let current = await readInitialImport(db);
  if (!current) {
    await db.prepare(`INSERT INTO initial_import(id, token, state)
      SELECT 1, ?, 'importing' WHERE NOT EXISTS (SELECT 1 FROM files)
        AND NOT EXISTS (SELECT 1 FROM changelog) AND NOT EXISTS (SELECT 1 FROM file_versions)
        AND NOT EXISTS (SELECT 1 FROM file_deletion_receipts) AND NOT EXISTS (SELECT 1 FROM upload_operations)
        AND NOT EXISTS (SELECT 1 FROM maintenance_state WHERE key = 'e2ee:state')
      ON CONFLICT(id) DO NOTHING`).bind(crypto.randomUUID()).run();
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
  if (after) {
    const stored = await db.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(IMPORT_VERIFICATION_KEY).first<{ value: string }>();
    const progress = stored ? JSON.parse(stored.value) as { token?: string; generation?: number; cursor?: string } : null;
    if (progress?.token !== current.token || progress.generation !== current.generation || progress.cursor !== after) {
      return corsResponse({ error: 'Initial upload changed. Sync again to resume.' }, 409);
    }
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
    await db.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime(\'now\')')
      .bind(IMPORT_VERIFICATION_KEY, JSON.stringify({ token: current.token, generation: current.generation, cursor })).run();
    return corsResponse({ cursor });
  }
  await db.batch([
    db.prepare(`UPDATE initial_import SET state = 'complete', snapshot_seq = MAX(snapshot_seq, 1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM changelog))
      WHERE id = 1 AND token = ? AND state = 'importing' AND generation = ?`).bind(current.token, current.generation),
    db.prepare(`INSERT INTO sqlite_sequence(name, seq) SELECT 'changelog', snapshot_seq FROM initial_import
      WHERE state = 'complete' AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'changelog')`),
    db.prepare(`UPDATE sqlite_sequence SET seq = MAX(seq, (SELECT snapshot_seq FROM initial_import))
      WHERE name = 'changelog' AND EXISTS (SELECT 1 FROM initial_import WHERE state = 'complete')`),
    // Folder setup can finish an empty reminder scan before the first upload starts.
    db.prepare(`DELETE FROM maintenance_state WHERE key LIKE 'reminder_source_scan_%'
      AND EXISTS (SELECT 1 FROM initial_import WHERE state = 'complete')`),
    db.prepare(`INSERT INTO maintenance_state(key, value) SELECT ?, token FROM initial_import
      WHERE state = 'complete' AND EXISTS (SELECT 1 FROM notification_policy)
      ON CONFLICT(key) DO NOTHING`).bind(INITIAL_REMINDERS_PENDING),
    db.prepare('DELETE FROM maintenance_state WHERE key = ?').bind(IMPORT_VERIFICATION_KEY),
  ]);
  const finished = await readInitialImport(db);
  if (finished?.state !== 'complete') return corsResponse({ error: 'Initial upload changed. Sync again to resume.' }, 409);
  return corsResponse({ lastSeq: finished.snapshot_seq });
}

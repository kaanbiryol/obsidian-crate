import { importInventoryHash, type InitialImport } from '@/protocol/initial-import';
import { createPathRecord } from '@/protocol/path-record';
import { corsResponse } from './cors';
import { parseJsonObject } from './utils';
import { INITIAL_REMINDERS_PENDING } from './initial-import-readiness';

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
      ON CONFLICT(id) DO NOTHING`).bind(crypto.randomUUID()).run();
    current = await readInitialImport(db);
  }
  const preparing = current?.state === 'complete' && Boolean(await db.prepare('SELECT 1 FROM maintenance_state WHERE key = ? AND value = ?')
    .bind(INITIAL_REMINDERS_PENDING, current.token).first());
  if (preparing) await wakeReminders?.();
  return corsResponse({ import: current?.state === 'importing' || preparing ? current : null });
}

export async function finishInitialImport(request: Request, db: D1Database): Promise<Response> {
  const parsed = await parseJsonObject(request);
  if (!parsed.ok) return parsed.response;
  const current = await readInitialImport(db);
  if (!current || current.token !== parsed.value.token) return corsResponse({ error: 'Unknown initial import' }, 409);
  if (current.state === 'complete') return corsResponse({ lastSeq: current.snapshot_seq });
  const rows = await db.prepare('SELECT path, hash, size FROM files').all<{ path: string; hash: string; size: number }>();
  const files = createPathRecord<{ hash: string; size: number }>();
  for (const row of rows.results) files[row.path] = row;
  if (parsed.value.inventoryHash !== await importInventoryHash(files)) {
    return corsResponse({ error: 'Initial upload is incomplete. Sync again to resume.' }, 409);
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
  ]);
  const finished = await readInitialImport(db);
  if (finished?.state !== 'complete') return corsResponse({ error: 'Initial upload changed. Sync again to resume.' }, 409);
  return corsResponse({ lastSeq: finished.snapshot_seq });
}

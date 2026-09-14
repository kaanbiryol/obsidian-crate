import { portablePathKey } from '../../protocol/portable-path';
import { readInitialImport } from './initial-import';
import { corsResponse } from './cors';
import { isSha256Hex, parseJsonObject, sanitizePath } from './utils';

/** Remove files deleted locally while an unpublished import was paused. */
export async function pruneInitialImport(request: Request, db: D1Database): Promise<Response> {
  const parsed = await parseJsonObject(request);
  if (!parsed.ok) return parsed.response;
  const current = await readInitialImport(db);
  if (!current || current.state !== 'importing' || current.token !== parsed.value.token) return corsResponse({ error: 'Initial import is closed or unavailable' }, 409);
  const files = parsed.value.files;
  if (!Array.isArray(files) || files.length > 50 || files.some((value: unknown) => {
    if (!value || typeof value !== 'object') return true;
    const file = value as Record<string, unknown>;
    return typeof file.path !== 'string' || !sanitizePath(file.path) || typeof file.hash !== 'string' || !isSha256Hex(file.hash);
  })) {
    return corsResponse({ error: 'Invalid import file list' }, 400);
  }
  const predicate = `portable_path IN (SELECT json_extract(value, '$.portable') FROM json_each(?1))
    AND EXISTS (SELECT 1 FROM json_each(?1) i WHERE json_extract(i.value, '$.path') = files.path
    AND json_extract(i.value, '$.hash') = files.hash)
    AND EXISTS (SELECT 1 FROM initial_import WHERE token = ?2 AND state = 'importing')`;
  const json = JSON.stringify((files as Array<{ path: string; hash: string }>).map(file => ({ ...file, portable: portablePathKey(file.path) })));
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO object_cleanup_queue(storage_key, file_path) SELECT storage_key, path FROM files WHERE ${predicate}`).bind(json, current.token),
    db.prepare(`DELETE FROM files WHERE ${predicate}`).bind(json, current.token),
    db.prepare("UPDATE initial_import SET generation = generation + 1 WHERE token = ? AND state = 'importing'").bind(current.token),
  ]);
  return corsResponse({ success: true });
}

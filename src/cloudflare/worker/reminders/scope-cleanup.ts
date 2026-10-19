/** Retire legacy whole-vault indexes without reading any note content. */
export async function retireOutOfScopeSources(db: D1Database, folder: string | null): Promise<boolean> {
  const predicate = (column: string) => folder === null ? '1' : `${column} < ? OR ${column} >= ?`;
  const rows = await db.prepare(`SELECT DISTINCT file_path FROM (
    SELECT * FROM (SELECT file_path FROM reminder_source_state WHERE ${predicate('file_path')} LIMIT 64)
    UNION ALL SELECT * FROM (SELECT file_path FROM reminder_sources WHERE ${predicate('file_path')} LIMIT 64)
    UNION ALL SELECT * FROM (SELECT path AS file_path FROM notification_projection_jobs WHERE ${predicate('path')} LIMIT 64)) LIMIT 64`)
    .bind(...(folder === null ? [] : Array.from({ length: 3 }, () => [`${folder}/`, `${folder}0`]).flat())).all<{ file_path: string }>();
  if (!rows.results.length) return false;
  const json = JSON.stringify(rows.results.map(row => row.file_path));
  await db.batch([
    db.prepare('DELETE FROM reminder_sources WHERE file_path IN (SELECT value FROM json_each(?))').bind(json),
    db.prepare('DELETE FROM reminder_source_state WHERE file_path IN (SELECT value FROM json_each(?))').bind(json),
    db.prepare('DELETE FROM notification_file_retries WHERE path IN (SELECT value FROM json_each(?))').bind(json),
    db.prepare(`DELETE FROM notification_projection_jobs WHERE path IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM reminder_projections WHERE file_path = notification_projection_jobs.path)`).bind(json),
  ]);
  // Projection jobs with old schedules are drained separately, without parsing their files.
  return rows.results.length === 64;
}

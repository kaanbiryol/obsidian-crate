import { readEncryptionState } from '../encryption/state';
import { FILE_FOLDER_MATCH, fileFolderArgs, fileRevisionGuard } from '../sync/file-identity';
import { managedArticle } from '@/reading/core/article';
import { parseReadingNote } from '@/reading/core/notes';
import { readingUrlIdentity } from '@/reading/core/model';
import { ReadingError, readSource } from './common';
import type { ReadingPolicy } from '@/protocol/reading-policy';
import type { Env } from '../types';
import { vaultChangeToken } from '../vault-change-token';
import { sha256Hex } from '@/platform/sha256';

export const READING_PROJECTION_KEY = 'reading_projection';

/** Rows are a pure function of the folder's file revisions and the policy, so a
 * complete projection stays complete until a file write changes the vault token. */
// Bump with the `_highlightIndex` row format below, so upgraded rows are rebuilt.
const PROJECTION_FORMAT = 1;
const projectionScope = (current: ReadingPolicy) => `reading:${current.generation}\nfolder:${current.folder_path}\nenabled:${current.enabled}\nformat:${PROJECTION_FORMAT}`;

/** Removing a source row without a file write must request a new projection. */
export const invalidateReadingProjection = (db: D1Database) => db.prepare('DELETE FROM maintenance_state WHERE key = ?').bind(READING_PROJECTION_KEY);

/** Rebuildable projection: all responses still verify the current immutable file revision. */
export async function projectReading(env: Env, current: ReadingPolicy): Promise<'complete' | 'pending' | 'unavailable'> {
  if (await readEncryptionState(env.DB)) return 'complete';
  const db = env.DB;
  // Every Reading read checks the projection. Skip the folder-wide checks when
  // nothing changed since the last complete pass.
  const token = await vaultChangeToken(db, projectionScope(current));
  if ((await db.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(READING_PROJECTION_KEY).first<{ value: string }>())?.value === token) return 'complete';
  // Current-generation sources are inside the Reading folder, so its primary-key range replaces a vault scan.
  await db.prepare(`DELETE FROM reading_sources WHERE generation != ? OR path NOT IN
    (SELECT path FROM files WHERE ${FILE_FOLDER_MATCH})`).bind(current.generation, ...fileFolderArgs(current.folder_path)).run();
  const { results } = await db.prepare(`SELECT f.path, f.storage_key AS revision FROM (SELECT path, storage_key FROM files WHERE ${FILE_FOLDER_MATCH}) f
    LEFT JOIN reading_sources s ON s.path = f.path WHERE lower(substr(f.path, -3)) = '.md'
    AND (s.revision IS NULL OR s.revision != f.storage_key OR s.generation != ? OR (s.metadata_json IS NOT NULL AND json_extract(s.metadata_json, '$._highlightIndex') IS NOT ${PROJECTION_FORMAT}) OR (? = 1 AND s.error IS NULL AND json_extract(s.metadata_json, '$.extraction_status')='pending'
      AND json_extract(s.metadata_json, '$.capture_method')='url' AND NOT EXISTS(SELECT 1 FROM reading_jobs j WHERE j.path=f.path)
      AND (SELECT count(*) FROM reading_jobs)<1000)) ORDER BY f.path LIMIT 25`)
    .bind(...fileFolderArgs(current.folder_path), current.generation, current.enabled).all<{ path: string; revision: string }>();
  let complete = results.length < 25;
  let unavailable = false;
  for (const row of results) {
    let metadata: ReturnType<typeof parseReadingNote> = null, error: string | null = null;
    let job: { hash: string; url: string } | null = null;
    let source: Awaited<ReturnType<typeof readSource>> | undefined;
    try { source = await readSource(env, row.path); }
    catch (failure) {
      if (failure instanceof ReadingError && failure.status === 413) error = failure.message;
      else { unavailable = true; continue; }
    }
    if (source && source.file.storageKey !== row.revision) { complete = false; continue; }
    try {
      if (source) metadata = parseReadingNote(source.content);
    } catch { error = 'This Reading note has invalid properties. Open it in Obsidian to check them.'; }
    if (source && current.enabled && metadata?.capture_method === 'url' && metadata.extraction_status === 'pending') {
      const block = managedArticle(source.content);
      if (!block || block.text.trim()) error = 'Article text was edited. Set extraction_status to ready in Obsidian to keep it as your saved article.';
      else job = { hash: await sha256Hex(block.text), url: metadata.source_url };
    }
    const revision = fileRevisionGuard(row.path, row.revision);
    await db.batch([
      db.prepare(`INSERT INTO reading_sources(path, revision, generation, item_id, url_identity, metadata_json, error)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${revision.sql}
        ON CONFLICT(path) DO UPDATE SET revision=excluded.revision, generation=excluded.generation, item_id=excluded.item_id,
        url_identity=excluded.url_identity, metadata_json=excluded.metadata_json, error=excluded.error`)
        .bind(row.path, row.revision, current.generation, metadata?.crate_reading_id ?? null,
          metadata?.source_url ? readingUrlIdentity(metadata.source_url) : null, metadata ? JSON.stringify({ ...metadata, _highlightIndex: PROJECTION_FORMAT }) : null, error, ...revision.args),
      ...(job && metadata ? [db.prepare(`INSERT INTO reading_jobs(path, item_id, generation, source_revision, block_hash, url, available_at)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM reading_sources WHERE path = ? AND revision = ?) AND (SELECT count(*) FROM reading_jobs)<1000
        ON CONFLICT(path) DO NOTHING`).bind(row.path, metadata.crate_reading_id, current.generation, row.revision, job.hash, job.url, Date.now(), row.path, row.revision)] : []),
    ]);
  }
  // Pending extractions are queued only while fewer than 1,000 jobs exist, so a
  // full queue must be revisited once it drains.
  if (complete && !unavailable && ((await db.prepare('SELECT count(*) AS jobs FROM reading_jobs').first<{ jobs: number }>())?.jobs ?? 0) < 1000) {
    await db.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(READING_PROJECTION_KEY, token).run();
  }
  return unavailable ? 'unavailable' : complete ? 'complete' : 'pending';
}

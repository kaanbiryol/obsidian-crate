import { parseReadingNote } from '@/reading/core/notes';
import { ARTICLE_START, ARTICLE_END, readingUrlIdentity } from '@/reading/core/model';
import { readSource, type ReadingPolicy } from './common';
import { sha256Hex } from '../auth';
import type { Env } from '../types';

export function managedArticle(content: string): { start: number; end: number; text: string } | null {
  const start = content.indexOf(ARTICLE_START), end = content.indexOf(ARTICLE_END);
  if (start < 0 || end < start || content.indexOf(ARTICLE_START, start + 1) >= 0 || content.indexOf(ARTICLE_END, end + 1) >= 0) return null;
  return { start: start + ARTICLE_START.length, end, text: content.slice(start + ARTICLE_START.length, end) };
}

/** Rebuildable projection: all responses still verify the current immutable file revision. */
export async function projectReading(env: Env, current: ReadingPolicy): Promise<boolean> {
  const db = env.DB;
  await db.prepare(`DELETE FROM reading_sources WHERE generation != ? OR NOT EXISTS
    (SELECT 1 FROM files WHERE path = reading_sources.path)`).bind(current.generation).run();
  const { results } = await db.prepare(`SELECT f.path, f.storage_key AS revision FROM files f LEFT JOIN reading_sources s ON s.path = f.path
    WHERE substr(f.path, 1, ?) = ? AND lower(substr(f.path, -3)) = '.md'
    AND (s.revision IS NULL OR s.revision != f.storage_key OR s.generation != ? OR (s.error IS NULL AND json_extract(s.metadata_json, '$.extraction_status')='pending'
      AND json_extract(s.metadata_json, '$.capture_method')='url' AND NOT EXISTS(SELECT 1 FROM reading_jobs j WHERE j.path=f.path)
      AND (SELECT count(*) FROM reading_jobs)<1000)) ORDER BY f.path LIMIT 25`)
    .bind(current.folder_path.length + 1, `${current.folder_path}/`, current.generation).all<{ path: string; revision: string }>();
  for (const row of results) {
    let metadata: ReturnType<typeof parseReadingNote> = null, error: string | null = null;
    let job: { hash: string; url: string } | null = null;
    try {
      const source = await readSource(env, row.path);
      if (source.file.storageKey !== row.revision) continue;
      metadata = parseReadingNote(source.content);
      if (metadata?.capture_method === 'url' && metadata.extraction_status === 'pending') {
        const block = managedArticle(source.content);
        if (!block || block.text.trim()) error = 'Article text was edited. Set extraction_status to ready in Obsidian to keep it as your saved article.';
        else job = { hash: await sha256Hex(block.text), url: metadata.source_url };
      }
    } catch { error = 'This note could not be read as a Reading note. Open it in Obsidian to check its properties.'; }
    await db.batch([
      db.prepare(`INSERT INTO reading_sources(path, revision, generation, item_id, url_identity, metadata_json, error)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM files WHERE path = ? AND storage_key = ?)
        ON CONFLICT(path) DO UPDATE SET revision=excluded.revision, generation=excluded.generation, item_id=excluded.item_id,
        url_identity=excluded.url_identity, metadata_json=excluded.metadata_json, error=excluded.error`)
        .bind(row.path, row.revision, current.generation, metadata?.crate_reading_id ?? null,
          metadata ? readingUrlIdentity(metadata.source_url) : null, metadata ? JSON.stringify(metadata) : null, error, row.path, row.revision),
      ...(job && metadata ? [db.prepare(`INSERT INTO reading_jobs(path, item_id, generation, source_revision, block_hash, url, available_at)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM reading_sources WHERE path = ? AND revision = ?) AND (SELECT count(*) FROM reading_jobs)<1000
        ON CONFLICT(path) DO NOTHING`).bind(row.path, metadata.crate_reading_id, current.generation, row.revision, job.hash, job.url, Date.now(), row.path, row.revision)] : []),
    ]);
  }
  return results.length < 25;
}

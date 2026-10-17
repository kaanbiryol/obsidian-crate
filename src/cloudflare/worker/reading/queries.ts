import type { Env } from '../types';
import { FILE_FOLDER_MATCH, fileFolderArgs } from '../file-identity';
import { ReadingError, sourceById, type ReadingPolicy } from './common';
import { readReadingFrontmatter } from '@/reading/core/frontmatter';
import { parseReadingNote } from '@/reading/core/notes';
import { validateReadingMetadata } from '@/reading/core/model';

/** Called only after route authorization and a complete Reading projection. */
export async function readingItem(env: Env, current: ReadingPolicy, id: string | null) {
  const queued = await env.DB.prepare('SELECT note FROM reading_captures WHERE id=? AND generation=?').bind(id, current.generation).first<{ note: string }>();
  if (queued) return { item: { ...parseReadingNote(queued.note)!, path: '' }, markdown: '' };
  const source = await sourceById(env, current, id);
  return { item: { ...source.item, path: source.path }, markdown: readReadingFrontmatter(source.content)?.body ?? '' };
}

export async function readingList(env: Env, current: ReadingPolicy, cursor: string) {
  if (cursor.length > 4096) throw new ReadingError('Invalid library cursor.');
  // Current-generation sources are inside the Reading folder, so its primary-key range replaces a vault scan.
  const currentFiles = `SELECT path, storage_key FROM files WHERE ${FILE_FOLDER_MATCH}`, folder = fileFolderArgs(current.folder_path);
  const { results } = await env.DB.prepare(`SELECT s.path, s.metadata_json, s.error,
    (SELECT count(*) FROM reading_sources d WHERE d.item_id=s.item_id AND d.generation=s.generation AND (d.path, d.revision) IN (${currentFiles})) AS copies
    FROM reading_sources s
    WHERE s.generation=? AND s.path>? AND (s.item_id IS NOT NULL OR s.error IS NOT NULL) AND (s.path, s.revision) IN (${currentFiles}) ORDER BY s.path LIMIT 100`)
    .bind(...folder, current.generation, cursor, ...folder).all<{ path: string; metadata_json: string | null; error: string | null; copies: number }>();
  const queued = cursor ? [] : (await env.DB.prepare('SELECT note FROM reading_captures WHERE generation=? ORDER BY available_at LIMIT 1000').bind(current.generation).all<{ note: string }>()).results;
  return { items: [...queued.map(row => ({ ...parseReadingNote(row.note)!, path: '' })), ...results.filter(row => row.metadata_json && row.copies === 1).map(row => ({ ...validateReadingMetadata(JSON.parse(row.metadata_json!) as Record<string, unknown>), path: row.path }))],
    issues: results.filter(row => row.error || row.copies > 1).map(row => ({ path: row.path, message: row.error ?? 'Several notes have this Reading ID. Fix the duplicates in Obsidian.' })),
    cursor: results.length === 100 ? results.at(-1)!.path : null };
}

import type { Env } from '../types';
import { FILE_FOLDER_MATCH, fileFolderArgs } from '../sync/file-identity';
import { ReadingError, sourceById } from './common';
import type { ReadingPolicy } from '@/protocol/reading-policy';
import { readReadingFrontmatter } from '@/reading/core/frontmatter';
import { parseReadingNote } from '@/reading/core/notes';
import { validateReadingMetadata } from '@/reading/core/model';
import { parseChangeEtags, vaultChangeToken } from '../vault-change-token';
import { sha256Hex } from '@/platform/sha256';

/** Called only after route authorization and a complete Reading projection. */
export async function readingItem(env: Env, current: ReadingPolicy, id: string | null) {
  const queued = await env.DB.prepare('SELECT note FROM reading_captures WHERE id=? AND generation=?').bind(id, current.generation).first<{ note: string }>();
  if (queued) return { item: { ...parseReadingNote(queued.note)!, path: '' }, markdown: '' };
  const source = await sourceById(env, current, id);
  return { item: { ...source.item, path: source.path }, markdown: readReadingFrontmatter(source.content)?.body ?? '' };
}

/** The library is a function of the folder's files and the capture queue. An
 * unchanged vault token answers without listing; otherwise an unchanged folder
 * revision still does, with a refreshed ETag. */
export async function readingListEtag(db: D1Database, current: ReadingPolicy, ifNoneMatch: string | null): Promise<{ etag: string; notModified: boolean }> {
  const captures = await db.prepare('SELECT count(*) AS n, COALESCE(max(available_at), 0) AS latest, COALESCE(sum(length(note)), 0) AS bytes FROM reading_captures WHERE generation=?')
    .bind(current.generation).first<{ n: number; latest: number; bytes: number }>();
  const scope = `reading-list:${current.generation}\nfolder:${current.folder_path}\nenabled:${current.enabled}\ncaptures:${captures?.n}:${captures?.latest}:${captures?.bytes}`;
  const changeToken = await vaultChangeToken(db, scope);
  const cached = parseChangeEtags(ifNoneMatch);
  const unchanged = cached.find(tag => tag.changeToken === changeToken);
  if (unchanged) return { etag: `"${unchanged.changeToken}.${unchanged.revision}"`, notModified: true };
  const files = await db.prepare(`SELECT path, storage_key FROM files WHERE ${FILE_FOLDER_MATCH} ORDER BY portable_path`)
    .bind(...fileFolderArgs(current.folder_path)).all<{ path: string; storage_key: string }>();
  const revision = (await sha256Hex([scope, ...files.results.map(file => `${file.path}\0${file.storage_key}`)].join('\n'))).slice(0, 32);
  return { etag: `"${changeToken}.${revision}"`, notModified: cached.some(tag => tag.revision === revision) };
}

// A changed library is reloaded page by page; larger pages keep that to a few
// requests for a 10,000-item library.
export const READING_LIST_PAGE = 1000;

export async function readingList(env: Env, current: ReadingPolicy, cursor: string) {
  if (cursor.length > 4096) throw new ReadingError('Invalid library cursor.');
  // Current-generation sources are inside the Reading folder, so its primary-key range replaces a vault scan.
  const currentFiles = `SELECT path, storage_key FROM files WHERE ${FILE_FOLDER_MATCH}`, folder = fileFolderArgs(current.folder_path);
  const { results } = await env.DB.prepare(`SELECT s.path, s.metadata_json, s.error,
    (SELECT count(*) FROM reading_sources d WHERE d.item_id=s.item_id AND d.generation=s.generation AND (d.path, d.revision) IN (${currentFiles})) AS copies
    FROM reading_sources s
    WHERE s.generation=? AND s.path>? AND (s.item_id IS NOT NULL OR s.error IS NOT NULL) AND (s.path, s.revision) IN (${currentFiles}) ORDER BY s.path LIMIT ${READING_LIST_PAGE}`)
    .bind(...folder, current.generation, cursor, ...folder).all<{ path: string; metadata_json: string | null; error: string | null; copies: number }>();
  const queued = cursor ? [] : (await env.DB.prepare('SELECT note FROM reading_captures WHERE generation=? ORDER BY available_at LIMIT 1000').bind(current.generation).all<{ note: string }>()).results;
  return { items: [...queued.map(row => ({ ...parseReadingNote(row.note)!, path: '' })), ...results.filter(row => row.metadata_json && row.copies === 1).map(row => ({ ...validateReadingMetadata(JSON.parse(row.metadata_json!) as Record<string, unknown>), path: row.path }))],
    issues: results.filter(row => row.error || row.copies > 1).map(row => ({ path: row.path, message: row.error ?? 'Several notes have this Reading ID. Fix the duplicates in Obsidian.' })),
    cursor: results.length === READING_LIST_PAGE ? results.at(-1)!.path : null };
}

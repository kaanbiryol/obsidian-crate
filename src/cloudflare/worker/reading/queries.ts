import type { Env } from '../types';
import { ReadingError, sourceById } from './common';
import type { ReadingPolicy } from '@/protocol/reading-policy';
import { readReadingFrontmatter } from '@/reading/core/frontmatter';
import { parseReadingNote } from '@/reading/core/notes';
import { validateReadingMetadata } from '@/reading/core/model';
import { sha256Hex } from '@/platform/sha256';
import { ARTICLE_EDITED_ERROR, readingIndexScope } from './library-index';

/** Called only after route authorization and a complete Reading index. */
export async function readingItem(env: Env, current: ReadingPolicy, id: string | null) {
	const queued = await env.DB.prepare('SELECT note FROM reading_captures WHERE id=? AND generation=?').bind(id, current.generation).first<{ note: string }>();
	if (queued) return { item: { ...parseReadingNote(queued.note)!, path: '' }, markdown: '' };
	const source = await sourceById(env, id);
	return { item: { ...source.item, path: source.path }, markdown: readReadingFrontmatter(source.content)?.body ?? '' };
}

/** The library changes only with its index revision, which every note and capture
 * queue change advances in its own transaction, and with the fetching setting. */
export async function readingListEtag(current: ReadingPolicy, revision: string): Promise<string> {
	return `"${(await sha256Hex(`${readingIndexScope(current)}\nenabled:${current.enabled}\nrevision:${revision}`)).slice(0, 32)}"`;
}

export const etagMatches = (header: string | null, etag: string) => header?.split(',').some(value => value.trim() === etag) ?? false;

// A changed library is reloaded page by page; larger pages keep that to a few
// requests for a 10,000-item library.
export const READING_LIST_PAGE = 1000;

export async function readingList(env: Env, current: ReadingPolicy, cursor: string) {
	if (cursor.length > 4096) throw new ReadingError('Invalid library cursor.');
	const { results } = await env.DB.prepare(`SELECT portable_path, path, metadata_json, error, article_edited, duplicate FROM reading_items
    WHERE portable_path > ? ORDER BY portable_path LIMIT ${READING_LIST_PAGE}`)
		.bind(cursor).all<{ portable_path: string; path: string; metadata_json: string | null; error: string | null; article_edited: number; duplicate: number }>();
	const queued = cursor ? [] : (await env.DB.prepare('SELECT note FROM reading_captures WHERE generation=? ORDER BY available_at LIMIT 1000').bind(current.generation).all<{ note: string }>()).results;
	const issue = (row: typeof results[number]) => row.error
		?? (row.article_edited && current.enabled ? ARTICLE_EDITED_ERROR : null)
		?? (row.duplicate ? 'Several notes have this Reading ID. Fix the duplicates in Obsidian.' : null);
	return { items: [...queued.map(row => ({ ...parseReadingNote(row.note)!, path: '' })), ...results.filter(row => row.metadata_json && !row.duplicate).map(row => ({ ...validateReadingMetadata(JSON.parse(row.metadata_json!) as Record<string, unknown>), path: row.path }))],
		issues: results.flatMap(row => { const message = issue(row); return message ? [{ path: row.path, message }] : []; }),
		cursor: results.length === READING_LIST_PAGE ? results.at(-1)!.portable_path : null };
}

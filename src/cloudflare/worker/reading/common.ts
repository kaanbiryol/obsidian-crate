import type { Env } from '../types';
import type { AuthPrincipal } from '../authenticate';
import { corsResponse } from '../cors';
import { sha256Hex } from '../auth';
import { getStoredFileRow } from '../sync-storage';
import { MAX_READING_BYTES } from '@/reading/core/model';
import { parseReadingNote } from '@/reading/core/notes';

export interface ReadingPolicy { enabled: number; folder_path: string; generation: string; revision: string }
export class ReadingError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'reading_error') { super(message); }
}
export const readingResponse = (value: unknown, status = 200) => corsResponse(value, status, { 'Cache-Control': 'no-store' });
export async function policy(db: D1Database): Promise<ReadingPolicy | null> {
  return db.prepare('SELECT enabled, folder_path, generation, revision FROM reading_policy WHERE id = 1').first<ReadingPolicy>();
}
export async function authority(db: D1Database, principal: AuthPrincipal): Promise<ReadingPolicy> {
  const current = await policy(db);
  if (!current?.enabled) throw new ReadingError('Reading is disabled. Enable it in Crate settings.', 403);
  if (principal.scope !== 'vault' && (principal.folderPath !== current.folder_path || principal.readingGeneration !== current.generation)) {
    throw new ReadingError('Open a fresh Reading setup link from Crate settings.', 401);
  }
  return current;
}
export async function readSource(env: Env, path: string) {
  const file = await getStoredFileRow(env.DB, path);
  if (!file) throw new ReadingError('This reading note was moved or deleted. Refresh your library.', 409);
  if (file.size > MAX_READING_BYTES) throw new ReadingError('Reading notes must be smaller than 1 MB.', 413);
  const object = await env.BUCKET.get(file.storageKey);
  if (!object || object.size !== file.size) throw new ReadingError('The saved text is temporarily unavailable.', 503);
  const content = await object.text();
  if (await sha256Hex(content) !== file.hash) throw new ReadingError('The saved text could not be verified.', 503);
  return { file, content };
}
export async function sourceById(env: Env, current: ReadingPolicy, id: unknown) {
  if (typeof id !== 'string' || id.length > 100) throw new ReadingError('Choose a saved link.');
  const { results } = await env.DB.prepare(`SELECT s.path FROM reading_sources s JOIN files f ON f.path = s.path AND f.storage_key = s.revision
    WHERE s.generation = ? AND s.item_id = ? LIMIT 2`).bind(current.generation, id).all<{ path: string }>();
  if (results.length !== 1) throw new ReadingError(results.length ? 'Several notes have this Reading ID. Fix the duplicate notes in Obsidian.' : 'This reading note was moved or deleted. Refresh your library.', 409);
  const path = results[0]!.path;
  const source = await readSource(env, path);
  const item = parseReadingNote(source.content);
  if (!item || item.crate_reading_id !== id || !path.startsWith(`${current.folder_path}/`)) throw new ReadingError('This reading note changed. Refresh your library.', 409);
  return { ...source, path, item };
}

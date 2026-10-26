import { featureEnabled, parseStoredFeaturePolicy } from '../feature-policy';
import type { Env } from '../types';
import type { AuthPrincipal } from '../auth/authenticate';
import { corsResponse } from '../cors';
import { getStoredFileRow, type FileStorageRow } from '../sync/storage';
import { MAX_READING_BYTES } from '@/reading/core/model';
import { parseReadingNote } from '@/reading/core/notes';
import { decodeReadingNote, READING_ENCODING_ERROR, READING_SIZE_ERROR, type StoredReadingFile } from './library-index';
import { apiRoutePolicy } from '../routes/policy';
import { READING_SHORTCUT_CONTRACT as shortcut } from '@/reading/shortcut';
import { sha256Hex } from '@/platform/sha256';
import type { ReadingPolicy } from '@/protocol/reading-policy';

/** Preparation and capability redemption must recognize the same issuer scopes. */
export function canPrepareReadingHandoff(scope: string): scope is AuthPrincipal['scope'] {
  return apiRoutePolicy(shortcut.preparePath, 'POST')!.scopes.some(allowed => allowed === scope);
}
export const readingResponse = (value: unknown, status = 200, headers: Record<string, string> = {}) => corsResponse(value, status, { 'Cache-Control': 'no-store', ...headers });
export class ReadingError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'reading_error') { super(message); }

  toResponse(): Response {
    return readingResponse({ error: this.message, code: this.code }, this.status);
  }
}
export async function policy(db: D1Database): Promise<ReadingPolicy | null> {
  return db.prepare('SELECT enabled, folder_path, generation, revision FROM reading_policy WHERE id = 1').first<ReadingPolicy>();
}
export async function authority(db: D1Database, principal: AuthPrincipal, featurePolicyValue?: string | null): Promise<ReadingPolicy> {
  // Authentication loads the feature policy with the token.
  const enabled = featurePolicyValue === undefined ? await featureEnabled(db, 'reading') : parseStoredFeaturePolicy(featurePolicyValue).reading;
  if (!enabled) throw new ReadingError('Reading is paused. Enable it in Crate settings.', 423, 'feature_paused');
  const current = await policy(db);
  if (!current) throw new ReadingError('Choose a Reading folder in Obsidian’s Crate settings first.', 403, 'reading_not_configured');
  if (principal.scope !== 'vault' && principal.scope !== 'reminders' && (principal.folderPath !== current.folder_path || principal.readingGeneration !== current.generation)) {
    throw new ReadingError('Reconnect this web app from Crate settings in Obsidian.', 401);
  }
  return current;
}
/** The verified bytes of one file revision. */
export async function readStoredNote(env: Env, file: StoredReadingFile): Promise<ArrayBuffer> {
  if (file.size > MAX_READING_BYTES) throw new ReadingError(READING_SIZE_ERROR, 413);
  const object = await env.BUCKET.get(file.storageKey);
  if (!object || object.size !== file.size) throw new ReadingError('The saved text is temporarily unavailable.', 503);
  // Verify the stored bytes, then decode; a lossy decode would never match the hash.
  const bytes = await object.arrayBuffer();
  if (await sha256Hex(bytes) !== file.hash) throw new ReadingError('The saved text could not be verified.', 503);
  return bytes;
}
function decodeStoredNote(bytes: ArrayBuffer): string {
  const content = decodeReadingNote(bytes);
  if (content === null) throw new ReadingError(READING_ENCODING_ERROR, 422, 'invalid_encoding');
  return content;
}
export async function readSource(env: Env, path: string): Promise<{ file: FileStorageRow; content: string }> {
  const file = await getStoredFileRow(env.DB, path);
  if (!file) throw new ReadingError('This reading note was moved or deleted. Refresh your library.', 409);
  return { file, content: decodeStoredNote(await readStoredNote(env, { path, ...file })) };
}
/** The index row names the current file revision, committed with it, so its bytes are read directly. */
export async function sourceById(env: Env, id: unknown) {
  if (typeof id !== 'string' || id.length > 100) throw new ReadingError('Choose a saved link.');
  const { results } = await env.DB.prepare('SELECT path, storage_key, hash, size FROM reading_items WHERE item_id = ? LIMIT 2')
    .bind(id).all<{ path: string; storage_key: string; hash: string; size: number }>();
  if (results.length !== 1) throw new ReadingError(results.length ? 'Several notes have this Reading ID. Fix the duplicate notes in Obsidian.' : 'This reading note was moved or deleted. Refresh your library.', 409);
  const row = results[0]!, file: FileStorageRow = { hash: row.hash, size: row.size, storageKey: row.storage_key };
  const content = decodeStoredNote(await readStoredNote(env, { path: row.path, ...file }));
  const item = parseReadingNote(content);
  if (!item || item.crate_reading_id !== id) throw new ReadingError('This reading note changed. Refresh your library.', 409);
  return { file, content, path: row.path, item };
}

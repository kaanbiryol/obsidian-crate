import { featureEnabled, parseStoredFeaturePolicy } from '../server/feature-policy';
import type { Env } from '../types';
import type { AuthPrincipal } from '../auth/authenticate';
import { corsHeaders, corsResponse } from '../http/cors';
import { getStoredFileRow, readVerifiedBytes, type FileStorageRow } from '../sync/storage';
import { MAX_READING_BYTES } from '@/reading/core/model';
import { parseReadingNote } from '@/reading/core/notes';
import { READING_DUPLICATE_ID_ISSUE } from '@/reading/core/inventory';
import { decodeReadingNote, READING_ENCODING_ERROR, READING_SIZE_ERROR, type StoredReadingFile } from './library-index';
import { apiRoutePolicy } from '../routes/policy';
import { READING_SHORTCUT_CONTRACT as shortcut } from '@/reading/shortcut';
import type { ReadingPolicy } from '@/protocol/reading-policy';

/** Preparation and capability redemption must recognize the same issuer scopes. */
export function canPrepareReadingHandoff(scope: string): scope is AuthPrincipal['scope'] {
	return apiRoutePolicy(shortcut.preparePath, 'POST')!.scopes.some(allowed => allowed === scope);
}
export const readingResponse = (value: unknown, status = 200, headers: Record<string, string> = {}) => corsResponse(value, status, { 'Cache-Control': 'no-store', ...headers });
export const readingNotModified = (etag: string) => new Response(null, { status: 304, headers: { ...corsHeaders(), 'Cache-Control': 'no-store', ETag: etag } });
export class ReadingError extends Error {
	constructor(message: string, readonly status = 400, readonly code = 'reading_error') { super(message); }

	toResponse(): Response {
		return readingResponse({ error: this.message, code: this.code }, this.status);
	}
}
export const policyStatement = (db: D1Database) => db.prepare('SELECT enabled, folder_path, generation, revision FROM reading_policy WHERE id = 1');
export async function policy(db: D1Database): Promise<ReadingPolicy | null> {
	return policyStatement(db).first<ReadingPolicy>();
}
/** `loaded` is the policy row when the caller already read it in a batch. */
export async function authority(db: D1Database, principal: AuthPrincipal, featurePolicyValue?: string | null, loaded?: ReadingPolicy | null): Promise<ReadingPolicy> {
	// Authentication loads the feature policy with the token.
	const enabled = featurePolicyValue === undefined ? await featureEnabled(db, 'reading') : parseStoredFeaturePolicy(featurePolicyValue).reading;
	if (!enabled) throw new ReadingError('Reading is paused. Enable it in Crate settings.', 423, 'feature_paused');
	const current = loaded !== undefined ? loaded : await policy(db);
	if (!current) throw new ReadingError('Choose a Reading folder in Obsidian’s Crate settings first.', 403, 'reading_not_configured');
	if (principal.scope !== 'vault' && principal.scope !== 'reminders' && (principal.folderPath !== current.folder_path || principal.readingGeneration !== current.generation)) {
		throw new ReadingError('Reconnect this web app from Crate settings in Obsidian.', 401);
	}
	return current;
}
/** The verified bytes of one file revision. */
export async function readStoredNote(env: Env, file: StoredReadingFile): Promise<ArrayBuffer> {
	if (file.size > MAX_READING_BYTES) throw new ReadingError(READING_SIZE_ERROR, 413);
	// Verify the stored bytes, then decode; a lossy decode would never match the hash.
	const bytes = await readVerifiedBytes(env.BUCKET, file);
	if (!bytes) throw new ReadingError('The saved text is temporarily unavailable.', 503);
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
export interface ReadingSourceRow { path: string; storage_key: string; hash: string; size: number }
export function readingItemId(id: unknown): string {
	if (typeof id !== 'string' || id.length > 100) throw new ReadingError('Choose a saved link.');
	return id;
}
export const sourceRowsStatement = (db: D1Database, id: string) => db.prepare('SELECT path, storage_key, hash, size FROM reading_items WHERE item_id = ? LIMIT 2').bind(id);
export function uniqueSourceRow(rows: ReadingSourceRow[]): ReadingSourceRow {
	if (rows.length !== 1) throw new ReadingError(rows.length ? READING_DUPLICATE_ID_ISSUE : 'This reading note was moved or deleted. Refresh your library.', 409);
	return rows[0]!;
}
/** The index row names the current file revision, committed with it, so its bytes are read directly. */
export async function readSourceRow(env: Env, id: string, row: ReadingSourceRow) {
	const file: FileStorageRow = { hash: row.hash, size: row.size, storageKey: row.storage_key };
	const content = decodeStoredNote(await readStoredNote(env, { path: row.path, ...file }));
	const item = parseReadingNote(content);
	if (!item || item.crate_reading_id !== id) throw new ReadingError('This reading note changed. Refresh your library.', 409);
	return { file, content, path: row.path, item };
}
export async function sourceById(env: Env, id: unknown) {
	const itemId = readingItemId(id);
	const { results } = await sourceRowsStatement(env.DB, itemId).all<ReadingSourceRow>();
	return readSourceRow(env, itemId, uniqueSourceRow(results));
}

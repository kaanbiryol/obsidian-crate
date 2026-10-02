import { ENCRYPTED_FILE_CONTENT_TYPE, MAX_ENCRYPTED_FILE_BYTES } from '../../encryption/file-format';
import type { EncryptionServerState } from '../../encryption/server-state';
import { corsHeaders, corsResponse } from './cors';
import { ENCRYPTION_FILE_PREFIX, validateEncryptedContent } from './encryption-state';
import { sha256HexBytes } from './auth';
import type { Env } from './types';
import { readLimitedRequestBody } from './body-reader';

interface ConversionFile { path: string; revision: string; hash: string; size: number }
export const CONVERSION_FILES = `SELECT path, storage_key AS revision, hash, size FROM files
	UNION SELECT path, storage_key AS revision, hash, size FROM file_versions`;

/** Conversion holds the coordinator lock and stops public reads/writes. An R2
 * replacement is atomic; a crash before D1 reconciliation is resumed from the
 * self-authenticating encrypted object. The first encrypted replacement wins. */
export async function convertFile(request: Request, env: Env, state: EncryptionServerState): Promise<Response> {
	const revision = new URL(request.url).searchParams.get('revision');
	if (!revision || revision.length > 1024) return corsResponse({ error: 'File revision required' }, 400);
	const file = await env.DB.prepare(`SELECT * FROM (${CONVERSION_FILES}) WHERE revision = ? LIMIT 1`).bind(revision).first<ConversionFile>();
	if (!file) return corsResponse({ error: 'File version is unavailable' }, 404);
	const object = await env.BUCKET.get(revision);
	if (!object || object.size > MAX_ENCRYPTED_FILE_BYTES) return corsResponse({ error: 'File version contents are unavailable' }, 503);
	if (request.method === 'GET') return new Response(object.body, { headers: { ...corsHeaders(), 'Cache-Control': 'no-store',
		'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream', 'Content-Length': String(object.size) } });
	if (request.method !== 'PUT') return corsResponse({ error: 'Method not allowed' }, 405);
	if (Number(request.headers.get('Content-Length')) > MAX_ENCRYPTED_FILE_BYTES) return corsResponse({ error: 'Encrypted file is too large' }, 413);
	let alreadyEncrypted = object.customMetadata?.crateEncryptionVault === state.vaultId
		&& object.customMetadata?.crateEncryptionGeneration === String(state.generation);
	let existingBytes: Uint8Array<ArrayBuffer> | undefined;
	if (!alreadyEncrypted && object.httpMetadata?.contentType === ENCRYPTED_FILE_CONTENT_TYPE) {
		// Resume replacements made by earlier clients, but never mistake original
		// plaintext (including a reserved MIME type) for converted content.
		existingBytes = new Uint8Array(await object.arrayBuffer());
		alreadyEncrypted = existingBytes.byteLength !== file.size || await sha256HexBytes(existingBytes) !== file.hash
			|| Boolean(await env.DB.prepare('SELECT 1 FROM maintenance_state WHERE key = ?').bind(ENCRYPTION_FILE_PREFIX + revision).first());
	}
	// Do not hold both complete versions of a large attachment in Worker memory.
	if (alreadyEncrypted) await request.body?.cancel();
	else if (!existingBytes) await object.body?.cancel();
	let content: Uint8Array<ArrayBuffer>;
	if (alreadyEncrypted) content = existingBytes ?? new Uint8Array(await object.arrayBuffer());
	else {
		existingBytes = undefined;
		const body = await readLimitedRequestBody(request, MAX_ENCRYPTED_FILE_BYTES, 'Encrypted file is too large');
		if (!body.ok) return body.response;
		content = body.bytes;
	}
	if (content.byteLength > MAX_ENCRYPTED_FILE_BYTES) return corsResponse({ error: 'Encrypted file is too large' }, 413);
	const descriptor = validateEncryptedContent(state, file.path, content);
	const hash = await sha256HexBytes(content);
	if (!alreadyEncrypted) await env.BUCKET.put(revision, content, {
		httpMetadata: { contentType: ENCRYPTED_FILE_CONTENT_TYPE }, customMetadata: { hash, crateEncryptionVault: state.vaultId, crateEncryptionGeneration: String(state.generation) },
	});
	await env.DB.batch([
		env.DB.prepare('UPDATE files SET hash = ?, size = ? WHERE storage_key = ?').bind(hash, content.byteLength, revision),
		env.DB.prepare('UPDATE file_versions SET hash = ?, size = ? WHERE storage_key = ?').bind(hash, content.byteLength, revision),
		env.DB.prepare('UPDATE changelog SET hash = ?, size = ? WHERE revision = ?').bind(hash, content.byteLength, revision),
		env.DB.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
			.bind(ENCRYPTION_FILE_PREFIX + revision, JSON.stringify(descriptor)),
	]);
	return corsResponse({ hash, size: content.byteLength, descriptor });
}

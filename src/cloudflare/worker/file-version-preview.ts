import { corsHeaders, corsResponse } from './cors';
import { sanitizePath } from './utils';
import { isSyncRevision } from '../../protocol/sync-validation';
import { storedObjectMatchesMetadata } from './sync-storage';
import { sha256HexBytes } from './auth';
import type { RemoteFileVersion } from '../../protocol/sync-types';

/** Read-only, bounded access to a retained object; never accepts arbitrary R2 keys. */
export async function handleFileVersionPreview(request: Request, bucket: R2Bucket, db: D1Database): Promise<Response> {
	const params = new URL(request.url).searchParams;
	const key = params.get('storageKey');
	const path = sanitizePath(params.get('path') ?? '');
	if (!isSyncRevision(key) || !path) return corsResponse({ error: 'A retained version and path are required' }, 400);
	const version = await db.prepare('SELECT * FROM file_versions WHERE storage_key = ? AND path = ? AND expires_at > ?')
		.bind(key, path, Date.now()).first<RemoteFileVersion>();
	if (!version) return corsResponse({ error: 'File version not found or expired' }, 404);
	if (version.size > 256_000) return corsResponse({ error: 'This file is too large to preview (limit: 256 KB).' }, 413);
	const object = await bucket.get(key);
	if (!object || object.size > 256_000 || !storedObjectMatchesMetadata(object, { hash: version.hash, size: version.size, storageKey: key })) {
		return corsResponse({ error: 'Stored file version content is unavailable' }, 503);
	}
	const content = await object.arrayBuffer();
	if (content.byteLength !== version.size || await sha256HexBytes(content) !== version.hash) {
		return corsResponse({ error: 'Stored file version content failed integrity validation' }, 503);
	}
	return new Response(content, { headers: { ...corsHeaders(), 'Content-Type': 'application/octet-stream',
		'Content-Length': String(content.byteLength), 'X-File-Hash': version.hash, 'Cache-Control': 'private, no-store' } });
}

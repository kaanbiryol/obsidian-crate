import { isPathInFolder } from '@/protocol/note-paths';
import { readingImageType } from '@/reading/core/article-images';
import { MAX_ENCRYPTED_FILE_BYTES } from '../../../encryption/file-format';
import { corsHeaders } from '../http/cors';
import { sanitizePath } from '../http/request-validation';
import { getStoredFileRow, storedObjectMatchesMetadata } from '../sync/storage';
import { ReadingError } from './common';
import type { ReadingPolicy } from '@/protocol/reading-policy';
import type { Env } from '../types';

/** One image file inside the Reading folder, for the web app reader. The response is always
 * served as the raster type its name declares, so a stored file cannot run as a page. */
export async function readReadingImage(env: Env, current: Pick<ReadingPolicy, 'folder_path'>, url: URL): Promise<Response> {
	const raw = url.searchParams.get('path') ?? '';
	const path = sanitizePath(raw), type = path ? readingImageType(path) : null;
	if (!path || path !== raw || !isPathInFolder(path, current.folder_path) || !type) throw new ReadingError('Choose an image in the Reading folder.', 400);
	const stored = await getStoredFileRow(env.DB, path);
	if (!stored?.storageKey) throw new ReadingError('Image not found.', 404, 'not_found');
	if (stored.size > MAX_ENCRYPTED_FILE_BYTES) throw new ReadingError('Image is too large.', 413);
	const object = await env.BUCKET.get(stored.storageKey);
	if (!object || !storedObjectMatchesMetadata(object, stored)) throw new ReadingError('Image content unavailable.', 503);
	return new Response(object.body, { headers: {
		'Content-Type': type, 'Content-Length': String(object.size), 'X-Content-Type-Options': 'nosniff',
		'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-store', ...corsHeaders(),
	} });
}

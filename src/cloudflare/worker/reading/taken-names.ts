import type { Env } from '../types';
import type { ReadingPolicy } from '@/protocol/reading-policy';
import { readingResponse, ReadingError } from './common';
import { portablePathKey } from '@/protocol/portable-path';
import { isReadingNotePath } from './library-index';

/** Which of these server paths hold a note in the encrypted Reading folder, so a device can
 * tell whether a name is taken without the server reading names. */
export async function takenReadingPaths(env: Env, current: ReadingPolicy, params: URLSearchParams) {
	const paths = params.getAll('path');
	if (!paths.length || paths.length > 20 || !paths.every(path => isReadingNotePath(path, current.folder_path))) throw new ReadingError('Invalid Reading paths.');
	const { results } = await env.DB.prepare('SELECT path FROM reading_items WHERE portable_path IN (SELECT value FROM json_each(?))')
		.bind(JSON.stringify(paths.map(portablePathKey))).all<{ path: string }>();
	return readingResponse({ paths: results.map(row => row.path) });
}

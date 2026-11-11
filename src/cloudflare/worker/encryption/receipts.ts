import { corsResponse } from '../http/cors';

/** The deletion receipt that consumed a file revision, if any. */
export async function handleDeletionPrecondition(request: Request, db: D1Database): Promise<Response> {
	const params = new URL(request.url).searchParams;
	const row = await db.prepare('SELECT hash FROM file_versions WHERE storage_key = ? AND path = ? AND deletion_revision IS NOT NULL').bind(params.get('revision'), params.get('path')).first<{ hash: string }>();
	return corsResponse({ receipt: row });
}

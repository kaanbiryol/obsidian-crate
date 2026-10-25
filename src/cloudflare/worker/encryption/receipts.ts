import { corsResponse } from '../cors';

/** The deletion receipt that consumed a file revision, if any. */
export async function handleDeletionPrecondition(request: Request, db: D1Database): Promise<Response> {
	const params = new URL(request.url).searchParams;
	const row = await db.prepare('SELECT consumed_hash AS hash FROM file_deletion_receipts WHERE consumed_revision = ? AND path = ?').bind(params.get('revision'), params.get('path')).first<{ hash: string }>();
	return corsResponse({ receipt: row });
}

import { corsResponse } from '../http/cors';
import { descriptorField } from './state';

/** The deletion receipt that consumed a file revision, if any, with that revision's descriptor. */
export async function handleDeletionPrecondition(request: Request, db: D1Database): Promise<Response> {
	const params = new URL(request.url).searchParams;
	const row = await db.prepare('SELECT hash, descriptor FROM file_versions WHERE storage_key = ? AND path = ? AND deletion_revision IS NOT NULL')
		.bind(params.get('revision'), params.get('path')).first<{ hash: string; descriptor: string | null }>();
	return corsResponse({ receipt: row && { hash: row.hash, ...descriptorField(row.descriptor) } });
}

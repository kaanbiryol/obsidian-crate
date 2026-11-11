import { ENCRYPTION_METADATA_BATCH } from '../../../protocol/sync-limits';
import { validateFileDescriptor } from '../../../encryption/file-format';
import { parseJsonObject } from '../http/request-validation';
import { corsResponse } from '../http/cors';

/** Published encryption descriptors for a batch of file revisions. Read responses carry
 * each revision's descriptor inline, so current clients ask here only for revisions
 * listed without one, such as shared checkpoint entries; older clients ask for all.
 * A descriptor lives in its revision's `files`, `file_versions` and changelog `put`
 * rows. Only `file_versions` is keyed by revision; the other two are scanned once. */
export async function handleEncryptionMetadata(request: Request, db: D1Database): Promise<Response> {
	const parsed = await parseJsonObject(request);
	if (!parsed.ok) return parsed.response;
	const revisions = parsed.value.revisions;
	if (!Array.isArray(revisions) || revisions.length > ENCRYPTION_METADATA_BATCH || revisions.some(id => typeof id !== 'string' || !id || id.length > 1024)) {
		return corsResponse({ error: `Up to ${ENCRYPTION_METADATA_BATCH} file revisions are required` }, 400);
	}
	const requested = 'SELECT value FROM json_each(?1)';
	const rows = revisions.length ? (await db.prepare(`SELECT storage_key AS revision, descriptor FROM file_versions
			WHERE storage_key IN (${requested}) AND descriptor IS NOT NULL
		UNION SELECT storage_key, descriptor FROM files WHERE storage_key IN (${requested}) AND descriptor IS NOT NULL
		UNION SELECT revision, descriptor FROM changelog WHERE revision IN (${requested}) AND action = 'put' AND descriptor IS NOT NULL`)
		.bind(JSON.stringify(revisions)).all<{ revision: string; descriptor: string }>()).results : [];
	const descriptors: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	for (const row of rows) {
		const descriptor: unknown = JSON.parse(row.descriptor);
		validateFileDescriptor(descriptor);
		descriptors[row.revision] = descriptor;
	}
	return corsResponse({ descriptors }, 200, { 'Cache-Control': 'no-store' });
}

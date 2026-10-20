import { ENCRYPTION_METADATA_BATCH } from '../../../protocol/sync-limits';
import { ENCRYPTION_FILE_PREFIX } from './state';
import { validateFileDescriptor } from '../../../encryption/file-format';
import { parseJsonObject } from '../request-validation';
import { corsResponse } from '../cors';

/** Published encryption descriptors for a batch of file revisions. */
export async function handleEncryptionMetadata(request: Request, db: D1Database): Promise<Response> {
	const parsed = await parseJsonObject(request);
	if (!parsed.ok) return parsed.response;
	const revisions = parsed.value.revisions;
	if (!Array.isArray(revisions) || revisions.length > ENCRYPTION_METADATA_BATCH || revisions.some(id => typeof id !== 'string' || !id || id.length > 1024)) {
		return corsResponse({ error: `Up to ${ENCRYPTION_METADATA_BATCH} file revisions are required` }, 400);
	}
	const rows = await db.prepare(`SELECT key, value FROM maintenance_state WHERE key IN (SELECT ? || value FROM json_each(?))`)
		.bind(ENCRYPTION_FILE_PREFIX, JSON.stringify(revisions)).all<{ key: string; value: string }>();
	const descriptors: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	for (const row of rows.results) {
		const descriptor: unknown = JSON.parse(row.value);
		validateFileDescriptor(descriptor);
		descriptors[row.key.slice(ENCRYPTION_FILE_PREFIX.length)] = descriptor;
	}
	return corsResponse({ descriptors }, 200, { 'Cache-Control': 'no-store' });
}

import { ENCRYPTION_METADATA_BATCH } from '../../../protocol/sync-limits';
import { validateFileDescriptor } from '../../../encryption/file-format';
import { portablePathKey } from '../../../protocol/portable-path';
import { isSyncRevision } from '../../../protocol/sync-validation';
import { parseJsonObject, sanitizePath } from '../http/request-validation';
import { corsResponse } from '../http/cors';
import { unpackDescriptor } from './descriptor-column';

/** Published encryption descriptors for a batch of `{ path, revision }` pairs. Read
 * responses carry each revision's descriptor inline, so clients ask here only for
 * revisions listed without one, such as shared checkpoint entries. A revision with bytes
 * is a live file or a retained version, so each pair is two unique-key lookups: `files`
 * by portable path and `file_versions` by storage key. A revision that is neither has no
 * bytes left to open, and is left out. */
export async function handleEncryptionMetadata(request: Request, db: D1Database): Promise<Response> {
	// 1,000 pairs of a 1,024-character path and its revision.
	const parsed = await parseJsonObject(request, 2 * 1024 * 1024);
	if (!parsed.ok) return parsed.response;
	const files = parsed.value.files;
	const pairs: Array<{ portable: string; revision: string }> = [];
	if (Array.isArray(files) && files.length <= ENCRYPTION_METADATA_BATCH) {
		for (const file of files as unknown[]) {
			const { path, revision } = (file && typeof file === 'object' ? file : {}) as Record<string, unknown>;
			const safePath = typeof path === 'string' ? sanitizePath(path) : null;
			if (!safePath || !isSyncRevision(revision)) break;
			pairs.push({ portable: portablePathKey(safePath), revision });
		}
	}
	if (!Array.isArray(files) || pairs.length !== files.length) {
		return corsResponse({ error: `Up to ${ENCRYPTION_METADATA_BATCH} file paths and revisions are required` }, 400);
	}
	// The retained copy is looked up only for a revision that is not live, so each live
	// revision reads two rows (its input and its file row) and a retained one three.
	const rows = pairs.length ? (await db.prepare(`WITH input AS (SELECT json_extract(value, '$.portable') AS portable,
      json_extract(value, '$.revision') AS revision FROM json_each(?1))
    SELECT i.revision, COALESCE(f.descriptor, v.descriptor) AS descriptor FROM input i
      LEFT JOIN files f ON f.portable_path = i.portable AND f.storage_key = i.revision
      LEFT JOIN file_versions v ON f.portable_path IS NULL AND v.storage_key = i.revision
    WHERE COALESCE(f.descriptor, v.descriptor) IS NOT NULL`)
		.bind(JSON.stringify(pairs)).all<{ revision: string; descriptor: string }>()).results : [];
	const descriptors: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	for (const row of rows) {
		const descriptor: unknown = unpackDescriptor(row.descriptor);
		validateFileDescriptor(descriptor);
		descriptors[row.revision] = descriptor;
	}
	return corsResponse({ descriptors }, 200, { 'Cache-Control': 'no-store' });
}

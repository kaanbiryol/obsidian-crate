import { isRecord, isSha256Hex } from '../../platform/validation';
import { isOptionalDescriptor, isSyncDate, isSyncPath, isSyncRevision, isSyncSequence } from '../../protocol/sync-validation';
import type { FileVersionsPage, RemoteFileVersion } from '../../protocol/sync-types';
import { isWirePath } from '../../protocol/encrypted-path';
import type { WorkerApiHttpClient } from './http';

/** One page of retained versions, as stored (still encrypted in an encrypted vault). */
export async function requestFileVersions(http: WorkerApiHttpClient, query: URLSearchParams): Promise<FileVersionsPage> {
	return parseFileVersions(await http.requestJson<unknown>(`/sync/versions?${query.toString()}`));
}

export function parseFileVersions(value: unknown): FileVersionsPage {
	if (!isRecord(value) || !Array.isArray(value.versions) || value.versions.length > 100 || typeof value.hasMore !== 'boolean') {
		throw new Error('Update the Crate server to browse complete retained-file history');
	}
	if (value.hasMore && (!value.versions.length || typeof value.nextCursor !== 'string' || !value.nextCursor || value.nextCursor.length > 8192)
		|| !value.hasMore && value.nextCursor !== undefined) throw new Error('Invalid retained-file page');
	const versions: RemoteFileVersion[] = value.versions.map((row: unknown) => {
		if (!isRecord(row) || !isSyncPath(row.path) || !isSyncRevision(row.storage_key) || !isSha256Hex(row.hash)
			|| !isSyncSequence(row.size) || !isSyncSequence(row.expires_at) || !isSyncDate(row.created_at)
			|| row.reason !== 'replaced' && row.reason !== 'deleted'
			|| (row.wire !== undefined && (typeof row.wire !== 'string' || !isWirePath(row.wire)))
			|| !isOptionalDescriptor(row.descriptor)) throw new Error('Invalid retained-file metadata');
		return { path: row.path, storage_key: row.storage_key, hash: row.hash, size: row.size, expires_at: row.expires_at,
			created_at: row.created_at, reason: row.reason, ...(row.wire === undefined ? {} : { wire: row.wire }),
			...(row.descriptor === undefined ? {} : { descriptor: row.descriptor }) };
	});
	return { versions, hasMore: value.hasMore, ...(value.hasMore ? { nextCursor: value.nextCursor as string } : {}) };
}

import { isRecord } from '../../plugin/settings';
import { isSyncDate, isSyncHash, isSyncPath, isSyncRevision, isSyncSequence } from '../../protocol/sync-validation';
import type { FileVersionsPage, RemoteFileVersion } from '../../protocol/sync-types';

export function parseFileVersions(value: unknown): FileVersionsPage {
	if (!isRecord(value) || !Array.isArray(value.versions) || value.versions.length > 100 || typeof value.hasMore !== 'boolean') {
		throw new Error('Update the Crate server to browse complete retained-file history');
	}
	if (value.hasMore && (!value.versions.length || typeof value.nextCursor !== 'string' || !value.nextCursor || value.nextCursor.length > 8192)
		|| !value.hasMore && value.nextCursor !== undefined) throw new Error('Invalid retained-file page');
	const versions: RemoteFileVersion[] = value.versions.map((row: unknown) => {
		if (!isRecord(row) || !isSyncPath(row.path) || !isSyncRevision(row.storage_key) || !isSyncHash(row.hash)
			|| !isSyncSequence(row.size) || !isSyncSequence(row.expires_at) || !isSyncDate(row.created_at)
			|| row.reason !== 'replaced' && row.reason !== 'deleted') throw new Error('Invalid retained-file metadata');
		return { path: row.path, storage_key: row.storage_key, hash: row.hash, size: row.size, expires_at: row.expires_at,
			created_at: row.created_at, reason: row.reason };
	});
	return { versions, hasMore: value.hasMore, ...(value.hasMore ? { nextCursor: value.nextCursor as string } : {}) };
}

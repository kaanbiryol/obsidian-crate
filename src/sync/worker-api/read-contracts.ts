import { isRecord } from '../../plugin/settings';
import { isSyncDate, isSyncHash, isSyncPath, isSyncRevision, isSyncSequence, parseSyncFiles } from '../../protocol/sync-validation';
import type { ChangesResponse, CheckResponse, FileManifest, FileMetadataResponse } from '../../protocol/sync-types';

const invalid = (): never => { throw new Error('Invalid or unsupported sync response. Sync stopped before applying remote state.'); };
const optionalBoolean = (value: unknown): value is boolean | undefined => value === undefined || typeof value === 'boolean';

export function parseManifestPage(value: unknown): FileManifest & { lastSeq: number; snapshotSeq: number; hasMore: boolean } {
	if (!isRecord(value) || value.version !== 1 || !isSyncSequence(value.lastSeq) || !isSyncSequence(value.snapshotSeq)
		|| typeof value.hasMore !== 'boolean' || !optionalBoolean(value.truncated)
		|| value.snapshotSeq > value.lastSeq) return invalid();
	if (value.truncated) throw new Error('Remote manifest is too large to sync safely');
	const files = parseSyncFiles(value.files);
	if (value.hasMore && (!isSyncPath(value.nextCursor) || !Object.prototype.hasOwnProperty.call(files, value.nextCursor))) return invalid();
	if (!value.hasMore && value.nextCursor !== undefined) return invalid();
	return { version: 1, files, lastSeq: value.lastSeq, snapshotSeq: value.snapshotSeq, hasMore: value.hasMore,
		...(value.hasMore ? { nextCursor: value.nextCursor as string } : {}) };
}

export function parseFileMetadata(value: unknown, requested: string[]): FileMetadataResponse {
	if (!isRecord(value)) return invalid();
	const files = parseSyncFiles(value.files);
	if (Object.keys(files).some(path => !requested.includes(path))) return invalid();
	return { files };
}

export function parseChanges(value: unknown, since: number): ChangesResponse {
	if (!isRecord(value) || !Array.isArray(value.changes) || value.changes.length > 5000
		|| !isSyncSequence(value.lastSeq) || typeof value.hasMore !== 'boolean' || !optionalBoolean(value.cursorExpired)) return invalid();
	if (!value.cursorExpired && value.lastSeq < since) return invalid();
	let previous = since;
	const changes: ChangesResponse['changes'] = [];
	for (const change of value.changes) {
		if (!isRecord(change) || !isSyncSequence(change.seq) || change.seq <= previous || change.seq > value.lastSeq
			|| !isSyncPath(change.path) || !isSyncSequence(change.size) || !isSyncDate(change.created_at)
			|| !['put', 'delete'].includes(String(change.action))
			|| !(isSyncHash(change.hash) || change.action === 'delete' && change.hash === '')
			|| (change.revision != null && !isSyncRevision(change.revision))) return invalid();
		changes.push({ seq: change.seq, path: change.path, action: change.action as 'put' | 'delete', hash: change.hash,
			size: change.size, created_at: change.created_at, ...(change.revision == null ? {} : { revision: change.revision }) });
		previous = change.seq;
	}
	if (value.hasMore && !changes.length || !value.cursorExpired && !value.hasMore && previous !== value.lastSeq) return invalid();
	return { changes, lastSeq: value.lastSeq, hasMore: value.hasMore, ...(value.cursorExpired === undefined ? {} : { cursorExpired: value.cursorExpired }) };
}

export function parseChangesCheck(value: unknown, since: number): CheckResponse {
	if (!isRecord(value) || !isSyncSequence(value.lastSeq) || typeof value.hasChanges !== 'boolean'
		|| !optionalBoolean(value.cursorExpired) || value.hasChanges !== (value.lastSeq > since)
		|| !value.cursorExpired && value.lastSeq < since) return invalid();
	return { lastSeq: value.lastSeq, hasChanges: value.hasChanges, ...(value.cursorExpired === undefined ? {} : { cursorExpired: value.cursorExpired }) };
}

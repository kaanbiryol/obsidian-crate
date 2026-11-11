import { isRecord, isSha256Hex } from '../../platform/validation';
import { isOptionalDescriptor, isSyncDate, isSyncPath, isSyncRevision, isSyncSequence, parseSyncFiles } from '../../protocol/sync-validation';
import type { ChangesResponse, CheckResponse, FileManifest, FileMetadataResponse } from '../../protocol/sync-types';
import type { WorkerApiHttpClient } from './http';

const invalid = (): never => { throw new Error('Invalid or unsupported sync response. Sync stopped before applying remote state.'); };
const optionalBoolean = (value: unknown): value is boolean | undefined => value === undefined || typeof value === 'boolean';

/** The server's changelog ends before this device's cursor, so it lost history, as after
 * a restore from an older backup. This device's baselines describe a newer server state. */
export class ServerBehindError extends Error {
	constructor() {
		super('The server is behind this device, as after a restore from a backup.');
		this.name = 'ServerBehindError';
	}
}

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

/** Metadata of up to `BATCH_DOWNLOAD_MAX_FILES` server paths, as stored (still encrypted
 * in an encrypted vault). */
export async function requestFileMetadata(http: WorkerApiHttpClient, paths: string[]): Promise<FileMetadataResponse> {
	return parseFileMetadata(await http.requestJson<unknown>('/sync/metadata', {
		method: 'POST', body: JSON.stringify({ paths: [...new Set(paths)] }),
	}), paths);
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
	if (value.lastSeq < since) throw new ServerBehindError();
	let previous = since;
	const changes: ChangesResponse['changes'] = [];
	for (const change of value.changes) {
		if (!isRecord(change) || !isSyncSequence(change.seq) || change.seq <= previous || change.seq > value.lastSeq
			|| !isSyncPath(change.path) || !isSyncSequence(change.size) || !isSyncDate(change.created_at)
			|| !['put', 'delete'].includes(String(change.action))
			|| !(isSha256Hex(change.hash) || change.action === 'delete' && change.hash === '')
			|| !isSyncRevision(change.revision) || !isOptionalDescriptor(change.descriptor)) return invalid();
		changes.push({ seq: change.seq, path: change.path, action: change.action as 'put' | 'delete', hash: change.hash,
			size: change.size, created_at: change.created_at, revision: change.revision,
			...(change.descriptor === undefined ? {} : { descriptor: change.descriptor }) });
		previous = change.seq;
	}
	if (value.hasMore && !changes.length || !value.cursorExpired && !value.hasMore && previous !== value.lastSeq) return invalid();
	return { changes, lastSeq: value.lastSeq, hasMore: value.hasMore, ...(value.cursorExpired === undefined ? {} : { cursorExpired: value.cursorExpired }) };
}

export async function requestChangesCheck(http: WorkerApiHttpClient, since: number): Promise<CheckResponse> {
	return parseChangesCheck(await http.requestJson<unknown>(`/sync/check?since=${since}`), since);
}

export function parseChangesCheck(value: unknown, since: number): CheckResponse {
	if (!isRecord(value) || !isSyncSequence(value.lastSeq) || typeof value.hasChanges !== 'boolean'
		|| !optionalBoolean(value.cursorExpired) || value.hasChanges !== (value.lastSeq > since)) return invalid();
	// A server behind this cursor cannot continue it; the sync this starts finds out why.
	if (value.lastSeq < since) return { lastSeq: value.lastSeq, hasChanges: false, cursorExpired: true };
	return { lastSeq: value.lastSeq, hasChanges: value.hasChanges, ...(value.cursorExpired === undefined ? {} : { cursorExpired: value.cursorExpired }) };
}

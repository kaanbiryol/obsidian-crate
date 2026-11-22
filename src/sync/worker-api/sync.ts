import type { ConnectionTestResult } from '../types';
import type { EncryptedFiles, UploadPreconditions } from '../encryption/encrypted-files';
import { assignPlainPaths, type WireStore } from '../encryption/path-index';
import type { JournalUpload } from '../durability/upload-intent';
import { ENCRYPTED_FILE_CONTENT_TYPE } from '../../encryption/file-format';
import { base64ToArrayBuffer } from '@/platform/base64';
import type { RestoreIntent } from '../durability/restore-intent';
import type { RemoteFileVersion } from '../../protocol/sync-types';
import { BATCH_FILE_SIZE_LIMIT, deviceBatchLimits, MAX_PREVIEW_BYTES, UPLOAD_PART_BYTES, usesChunkedTransfer, type BatchLimits } from '../../protocol/sync-limits';
import { Platform } from 'obsidian';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { requestFileVersions } from './version-contract';
import { parseManifestPage, requestChangesCheck, requestFileMetadata } from './read-contracts';
import { readRawChanges, readRawManifest } from './manifest-read';
import { parseBatchDelete, parseBatchDownload, parseBatchUpload, parseUploadResult } from './mutation-contracts';
import { errorMessage } from '../../platform/logger';
import { HOST_STATUS_PATH, parseHostStatusResponse, type HostStatus } from '../../protocol/host-status';
import { refusedUploadResult } from '../failures';
import { runConcurrentTasks } from '../concurrency';
import type {
	BatchDeleteResponse,
	BatchDeleteFile,
	BatchDownloadResponse,
	BatchUploadFile,
	BatchUploadResponse,
	BackendDiagnostics,
	ChangelogEntry,
	ChangesResponse,
	CheckResponse,
	FileManifest,
	FileEntry,
	FileMetadataResponse,
	HealthResponse,
	FileVersionQuery,
	FileVersionsPage,
	UploadResult,
	RestoreFileRequest,
} from '../../protocol/sync-types';
import {
	isCompatibleCrateServer,
	type CrateServerInfo,
} from '../../protocol/server-info';
import { assertPortablePathNames } from '../../protocol/portable-path';
import { createPathRecord, getPathEntry } from '../../protocol/path-record';
import { FILE_HASH_HEADER, FILE_SIZE_HEADER, EXPECTED_HASH_HEADER, UPLOAD_OPERATION_HEADER, UPLOAD_OPERATIONS_HEADER, REVISION_HEADER } from '../../protocol/http-headers';
import {
	getHeader,
	TRANSFER_TIMEOUT_MS,
	transferTimeout,
	HttpError,
	type WorkerApiHttpClient,
} from './http';
import { sha256Hex } from '@/platform/sha256';
import { isRecord } from '@/platform/validation';
import { isAbortError } from '../abort';

// Bounds decrypted plaintext held at once while overlapping batch decryption.
const DECRYPT_CONCURRENCY = 4;
/** Plaintext bytes in one encrypted batch upload. Encryption and base64 grow the body,
 * which must stay within the Worker's 15 MiB JSON request limit; larger batches upload
 * file by file. */
const ENCRYPTED_BATCH_MAX_BYTES = 8 * 1024 * 1024;
/** With encryption, `content` is plaintext whose `hash` and `size` decryption verified. */
export interface DownloadedFile { content: ArrayBuffer; contentType: string; size: number; hash: string; revision?: string; verified?: true }
type BatchDownloadEntry = BatchDownloadResponse['files'][number];
/** Client-side batch entries: decrypted files carry verified bytes instead of base64. */
type DownloadedBatchFile = BatchDownloadEntry | (Omit<BatchDownloadEntry, 'content'> & { verifiedContent: ArrayBuffer });
export interface DownloadedBatch { files: DownloadedBatchFile[] }
/** Encrypted pages leave out deletes this device never synced, so `nextSince` is the raw page's last sequence. */
export type ChangesPage = ChangesResponse & { nextSince?: number };

/** Upload operation IDs carry the server's reminder operation day. */
function createUploadOperationId(info: CrateServerInfo): string {
	return createReminderOperationId(info.reminderOperationDay);
}

/** Retries one part of a large transfer after a network failure or server error, so a single
 * failed request does not restart the whole file. Refusals are returned at once. */
async function retryTransientRequest<T>(request: () => Promise<T>, attempts = 3): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try { return await request(); } catch (error) {
			const transient = !(error instanceof HttpError) || error.status === 0 || error.status >= 500;
			if (!transient || attempt >= attempts || isAbortError(error)) throw error;
			await new Promise(resolve => window.setTimeout(resolve, 1000 * attempt));
		}
	}
}

export class SyncWorkerApi {
	constructor(private readonly http: WorkerApiHttpClient) {}
	private encryption?: EncryptedFiles;
	private wireStore?: WireStore;
	setEncryption(encryption: EncryptedFiles): void {
		this.encryption = encryption;
		if (this.wireStore) encryption.paths.useStore(this.wireStore);
	}
	/** The local manifest maps server paths back to synced files, whichever is configured first. */
	useWireStore(store: WireStore): void {
		this.wireStore = store;
		this.encryption?.paths.useStore(store);
	}
	prepareUploadWire(file: JournalUpload, preconditions?: UploadPreconditions) { return this.encryption?.prepare(file, preconditions) ?? Promise.resolve(undefined); }
	async preloadUploadPreconditions(files: Array<{ path: string; expectedHash: string | null }>): Promise<UploadPreconditions | undefined> {
		return this.encryption?.preloadExpected(files.map(file => ({ path: file.path, expected: file.expectedHash })));
	}
	prepareRestoreWire(intent: RestoreIntent) { return this.encryption?.prepareRestore(intent) ?? Promise.resolve(undefined); }
	assertPreparedRestore(intent: RestoreIntent): void {
		if (!!this.encryption !== !!intent.encryptedWire || (this.encryption && (intent.encryptedWire!.vaultId !== this.encryption.keys.vaultId
			|| intent.encryptedWire!.generation !== this.encryption.generation))) throw new Error('Unlock the original vault keys before resuming this restore');
	}
	async assertPreparedUpload(file: JournalUpload): Promise<void> {
		if (this.encryption) await this.encryption.verifyPrepared(file);
		else if (file.encryptedWire) throw new Error('Unlock the vault before retrying encrypted uploads');
	}
	private assertWireContentType(contentType: string): void {
		if (!!this.encryption !== (contentType === ENCRYPTED_FILE_CONTENT_TYPE)) {
			throw new Error('Encrypted uploads must be prepared in the durable upload journal');
		}
	}
	/** Re-key server paths by plaintext path. Two server files claiming one name keep
	 * both: the one at the name's own tag keeps it, others get a distinct local name. */
	private async decryptEntries(files: Record<string, FileEntry>): Promise<Record<string, FileEntry>> {
		const encryption = this.encryption;
		if (!encryption) return files;
		const wires = Object.keys(files).sort();
		const entries = await encryption.metadata(wires.map(path => ({ path, entry: files[path]! })));
		const tagged = await Promise.all(entries.map(async item => await encryption.paths.tags.wire(item.path).catch(() => null) === item.wire));
		const plain = createPathRecord<FileEntry>();
		for (const { index, path } of assignPlainPaths(entries, tagged)) {
			const { wire, entry } = entries[index]!;
			const renamed = path !== entries[index]!.path;
			if (renamed) await encryption.paths.learn(path, wire);
			plain[path] = tagged[index] && !renamed ? entry : { ...entry, wire };
		}
		return plain;
	}

	private async wireFor(path: string): Promise<string> {
		return this.encryption ? this.encryption.paths.wireFor(path) : path;
	}

	async health(): Promise<HealthResponse> {
		return this.http.requestJson<HealthResponse>('/health');
	}

	async getServerInfo(): Promise<CrateServerInfo> {
		return this.http.getServerInfo();
	}

	async testConnection(): Promise<ConnectionTestResult> {
		try {
			const info = await this.getServerInfo();
			if (!isCompatibleCrateServer(info)) {
				return {
					success: false,
					error: `Incompatible Crate server protocol ${info.protocol.current}`,
					code: 'incompatible_protocol',
				};
			}
			const response = await this.health();
			return { success: response.status === 'ok' };
		} catch (error) {
			return {
				success: false,
				error: errorMessage(error),
			};
		}
	}

	async getDiagnostics(): Promise<BackendDiagnostics> {
		return this.http.requestJson<BackendDiagnostics>('/diagnostics');
	}

	/** Null for a Cloudflare deployment. */
	async getHostStatus(): Promise<HostStatus | null> {
		return parseHostStatusResponse(await this.http.requestJson<unknown>(HOST_STATUS_PATH));
	}

	/** One raw manifest entry is enough to tell whether the server stores any file. */
	async hasFiles(): Promise<boolean> {
		const page = parseManifestPage(await this.http.requestJson<unknown>('/sync/manifest?limit=1'));
		return Object.keys(page.files).length > 0;
	}

	async getManifest(): Promise<FileManifest> {
		const { files, lastSeq } = await this.getRawManifest();
		return { version: 1, files: await this.decryptEntries(files), lastSeq };
	}

	/** The manifest as the server stores it, at one snapshot: wire paths in an encrypted vault. */
	getRawManifest(): Promise<{ files: Record<string, FileEntry>; lastSeq: number }> {
		return readRawManifest(this.http);
	}

	async getFileMetadata(paths: string[]): Promise<FileMetadataResponse> {
		const requested = [...new Set(paths)];
		// Requested paths may include an old file and its replacement directory;
		// only returned live state must be a representable namespace.
		assertPortablePathNames(requested);
		const uniquePaths = [...new Set(await Promise.all(requested.map(path => this.wireFor(path))))];
		const files = createPathRecord<FileEntry>();

		const perRequest = this.batchLimits().downloadFiles;
		for (let index = 0; index < uniquePaths.length; index += perRequest) {
			const chunk = uniquePaths.slice(index, index + perRequest);
			const response = await requestFileMetadata(this.http, chunk);
			Object.assign(files, response.files);
		}

		return { files: await this.decryptEntries(files) };
	}

	async uploadFile(
		path: string,
		content: ArrayBuffer,
		hash: string,
		size: number,
		contentType: string,
		expectedHash: string | null,
		operationId?: string,
	): Promise<UploadResult> {
		this.assertWireContentType(contentType);
		operationId ??= await this.newUploadOperationId();
		const encodedPath = encodeURIComponent(path);
		return parseUploadResult(await this.http.requestJson<unknown>(`/sync/upload?path=${encodedPath}`, {
			method: 'PUT',
			body: content,
			headers: {
				[UPLOAD_OPERATION_HEADER]: operationId,
				'Content-Type': contentType,
				[FILE_HASH_HEADER]: hash,
				[FILE_SIZE_HEADER]: String(size),
				[EXPECTED_HASH_HEADER]: expectedHash === null ? 'absent' : expectedHash,
			},
		}, transferTimeout(content.byteLength)));
	}

	/** The batch sizes this device sends to its server; mobile keeps the defaults. */
	batchLimits(): BatchLimits {
		return deviceBatchLimits(this.http.serverBatchLimits(), Platform.isMobile);
	}

	/** Whether this file travels in parts on this server. */
	usesChunkedUpload(path: string, size: number): boolean {
		return usesChunkedTransfer(path, size, Boolean(this.encryption), this.http.supportsChunkedUploads());
	}

	/** Uploads a large plaintext file in parts under one operation. A stored receipt answers
	 * every step of a retry, and a resumed session accepts every part again. */
	async uploadChunked(path: string, content: ArrayBuffer, hash: string, size: number, contentType: string,
		expectedHash: string | null, operationId: string): Promise<UploadResult> {
		const headers = { [UPLOAD_OPERATION_HEADER]: operationId };
		const file = { path, hash, size, contentType, expectedHash };
		const begun = await this.http.requestJson<unknown>('/sync/upload-session?action=begin', { method: 'POST', body: JSON.stringify(file), headers });
		const partBytes = isRecord(begun) && isRecord(begun.session) ? begun.session.partBytes : undefined;
		if (partBytes === undefined) return parseUploadResult(begun);
		if (typeof partBytes !== 'number' || !Number.isSafeInteger(partBytes) || partBytes < 5 * 1024 * 1024) throw new Error('Server returned an invalid upload session');
		const parts: Array<{ partNumber: number; etag: string }> = [];
		for (let offset = 0, partNumber = 1; offset < size; offset += partBytes, partNumber++) {
			const body = content.slice(offset, Math.min(size, offset + partBytes));
			const response = await retryTransientRequest(() => this.http.requestJson<unknown>(`/sync/upload-session?part=${partNumber}`, {
				method: 'PUT', body, headers: { ...headers, 'Content-Type': 'application/octet-stream' },
			}, transferTimeout(body.byteLength)));
			if (!isRecord(response) || typeof response.etag !== 'string') throw new Error('Server returned an invalid upload part receipt');
			parts.push({ partNumber, etag: response.etag });
		}
		// The server reads the combined file back to check its hash before publishing it.
		return parseUploadResult(await this.http.requestJson<unknown>('/sync/upload-session?action=complete', {
			method: 'POST', body: JSON.stringify({ ...file, parts }), headers,
		}, transferTimeout(0) + Math.ceil(size / (8 * 1024 * 1024)) * 1000));
	}

	private async newUploadOperationId(): Promise<string> {
		return createUploadOperationId(await this.getServerInfo());
	}

	/** `size`, when known, extends the timeout for a large file, and a large plaintext file
	 * downloads in ranges on a server that offers them. */
	async downloadFile(path: string, size?: number): Promise<DownloadedFile> {
		const wire = await this.wireFor(path);
		const encodedPath = encodeURIComponent(wire);
		// An unknown size (0) is read from the first range's reply.
		const ranged = size ? this.usesChunkedUpload(path, size) : this.usesChunkedUpload(path, Number.MAX_SAFE_INTEGER);
		const { body, headers } = ranged
			? await this.downloadRanges(`/sync/download?path=${encodedPath}`, path)
			: await this.http.requestBinary(`/sync/download?path=${encodedPath}`, {}, transferTimeout(size ?? 0));
		const contentLengthHeader = getHeader(headers, 'Content-Length');
		const contentLength = contentLengthHeader && /^\d+$/.test(contentLengthHeader)
			? Number(contentLengthHeader)
			: body.byteLength;
		const result = {
			content: body,
			contentType: getHeader(headers, 'Content-Type') || 'application/octet-stream',
			size: Number.isSafeInteger(contentLength) ? contentLength : body.byteLength,
			hash: getHeader(headers, FILE_HASH_HEADER) || '',
			revision: getHeader(headers, REVISION_HEADER) || undefined,
		};
		if (!this.encryption) return result;
		const opened = await this.encryption.download(wire, body, { check: result, expected: path });
		return { ...result, content: opened.content, ...opened.metadata, verified: true };
	}

	/** Fetches a file in `UPLOAD_PART_BYTES` ranges into one buffer. Every range must come from
	 * the same stored revision; the caller still checks the whole file's hash. */
	private async downloadRanges(url: string, path: string): Promise<{ body: ArrayBuffer; headers: Record<string, string> }> {
		const range = (offset: number) => retryTransientRequest(() => this.http.requestBinary(url,
			{ headers: { Range: `bytes=${offset}-${offset + UPLOAD_PART_BYTES - 1}` } }, transferTimeout(UPLOAD_PART_BYTES)));
		const first = await range(0);
		// A reply without Content-Range holds the whole file, as for an empty one.
		const total = Number(/\/(\d+)$/.exec(getHeader(first.headers, 'Content-Range') ?? '')?.[1] ?? first.body.byteLength);
		if (!Number.isSafeInteger(total) || total < first.body.byteLength) throw new Error('Server returned an invalid download range');
		if (total === first.body.byteLength) return first;
		const bytes = new Uint8Array(total);
		bytes.set(new Uint8Array(first.body), 0);
		const revision = getHeader(first.headers, REVISION_HEADER);
		for (let offset = first.body.byteLength; offset < total; offset += UPLOAD_PART_BYTES) {
			const part = await range(offset);
			if (part.body.byteLength !== Math.min(UPLOAD_PART_BYTES, total - offset) || getHeader(part.headers, REVISION_HEADER) !== revision) {
				throw new Error(`${path} changed on the server while downloading. Sync again.`);
			}
			bytes.set(new Uint8Array(part.body), offset);
		}
		// The first part's length and range headers describe only that part.
		const headers = Object.fromEntries(Object.entries(first.headers).filter(([name]) => !['content-length', 'content-range'].includes(name.toLowerCase())));
		return { body: bytes.buffer, headers: { ...headers, 'Content-Length': String(total) } };
	}

	async checkForChanges(since: number): Promise<CheckResponse> {
		return requestChangesCheck(this.http, since);
	}

	async getChanges(since: number): Promise<ChangesPage> {
		const response = await this.getRawChanges(since);
		if (!this.encryption) return response;
		// Deletes carry no metadata, so each takes the name its server path had at that
		// point. A case-only rename keeps one server path, and opening the later put
		// must not rename the delete of the old name.
		const plainAt = new Map<string, string | undefined>();
		for (const change of response.changes) {
			if (change.action !== 'put' && !plainAt.has(change.path)) plainAt.set(change.path, await this.encryption.paths.plainFor(change.path));
		}
		const puts = response.changes.filter(change => change.action === 'put');
		const opened = await this.encryption.metadata(puts.map(entry => ({ path: entry.path, entry })));
		let index = 0;
		const changes: ChangelogEntry[] = [];
		for (const change of response.changes) {
			if (change.action === 'put') {
				const { path, entry } = opened[index++]!;
				plainAt.set(change.path, path);
				changes.push({ ...entry, path });
				continue;
			}
			// A deleted server path this device never synced has no local file to remove.
			const path = plainAt.get(change.path);
			if (path) changes.push({ ...change, path });
		}
		return { ...response, changes, nextSince: response.changes.at(-1)?.seq ?? since };
	}

	private getRawChanges(since: number): Promise<ChangesResponse> {
		return readRawChanges(this.http, since);
	}

	async batchUpload(files: BatchUploadFile[]): Promise<BatchUploadResponse> {
		for (const file of files) this.assertWireContentType(file.contentType);
		if (this.encryption && (files.some(file => file.size > BATCH_FILE_SIZE_LIMIT) || files.reduce((bytes, file) => bytes + file.size, 0) > ENCRYPTED_BATCH_MAX_BYTES)) {
			const results: UploadResult[] = [];
			for (const file of files) {
				try {
					results.push(await this.uploadFile(file.path, base64ToArrayBuffer(file.content), file.hash,
						file.size, file.contentType, file.expectedHash, file.operationId));
				} catch (error) {
					results.push(refusedUploadResult(file.path, error));
				}
			}
			return { success: results.every(result => result.success), results };
		}
		const info = await this.getServerInfo();
		if (files.some(file => !file.operationId)) {
			files = files.map(file => ({ ...file, operationId: file.operationId ?? createUploadOperationId(info) }));
		}
		const perRequest = this.batchLimits().uploadFiles;
		if (files.length > perRequest) {
			const results: BatchUploadResponse['results'] = [];
			for (let offset = 0; offset < files.length; offset += perRequest) {
				results.push(...(await this.batchUpload(files.slice(offset, offset + perRequest))).results);
			}
			return { success: results.every(result => result.success), results };
		}
		const bulkNew = files.every(file => file.expectedHash === null);

		const body = JSON.stringify({ files, ...(bulkNew ? { bulkNewFiles: true } : {}) });
		return parseBatchUpload(await this.http.requestJson<unknown>('/sync/batch-upload', {
			method: 'POST',
			body,
			headers: { [UPLOAD_OPERATIONS_HEADER]: files.map(file => file.operationId).join(',') },
		}, transferTimeout(body.length)));
	}

	async batchDownload(paths: string[]): Promise<DownloadedBatch> {
		let response: BatchDownloadResponse;
		const wires = await Promise.all(paths.map(path => this.wireFor(path)));
		const plainByWire = new Map(wires.map((wire, index) => [wire, paths[index]!]));
		try { response = parseBatchDownload(await this.http.requestJson<unknown>('/sync/batch-download', {
			method: 'POST',
			body: JSON.stringify({ paths: wires }),
		}, TRANSFER_TIMEOUT_MS)); }
		catch (error) {
			if (!this.encryption || !(error instanceof HttpError) || error.status !== 413) throw error;
			const files: DownloadedBatchFile[] = [];
			for (const path of paths) {
				const { content, verified: _verified, ...file } = await this.downloadFile(path);
				files.push({ ...file, path, verifiedContent: content });
			}
			return { files };
		}
		const encryption = this.encryption;
		if (!encryption) return response;
		const files = await runConcurrentTasks(response.files.map(({ content, ...file }) => async (): Promise<DownloadedBatchFile> => {
			const path = plainByWire.get(file.path) ?? file.path;
			if (file.error) return { ...file, path, content };
			const opened = await encryption.download(file.path, base64ToArrayBuffer(content), { check: file, expected: path });
			return { ...file, ...opened.metadata, path, verifiedContent: opened.content };
		}), DECRYPT_CONCURRENCY);
		return { files };
	}

	async batchDelete(
		paths: string[],
		expectedHashes: Record<string, string> = {},
		expectedRevisions: Record<string, string> = {},
	): Promise<BatchDeleteResponse> {
		const files: BatchDeleteFile[] = paths.map((path) => {
			const expectedHash = getPathEntry(expectedHashes, path);
			if (!expectedHash) {
				throw new Error(`Missing expected remote hash for delete: ${path}`);
			}
			const expectedRevision = getPathEntry(expectedRevisions, path);
			if (!expectedRevision) throw new HttpError('Missing remote revision; reconcile before deleting', 409, null, 'version_conflict');
			return { path, expectedHash, expectedRevision };
		});
		if (!this.encryption) return parseBatchDelete(await this.http.requestJson<unknown>('/sync/batch-delete', { method: 'POST', body: JSON.stringify({ files }) }));
		const hashes = await this.encryption.expectedHashes(files.map(file => ({ path: file.path, expected: file.expectedHash, revision: file.expectedRevision })));
		const wires = await Promise.all(files.map(file => this.wireFor(file.path)));
		const plainByWire = new Map(wires.map((wire, index) => [wire, paths[index]!]));
		const plain = (wire: string) => plainByWire.get(wire) ?? wire;
		const response = parseBatchDelete(await this.http.requestJson<unknown>('/sync/batch-delete', {
			method: 'POST',
			body: JSON.stringify({ files: files.map((file, index) => ({ ...file, path: wires[index]!, expectedHash: hashes[index]! })) }),
		}));
		return { ...response, deleted: response.deleted.map(plain),
			...(response.results ? { results: response.results.map(result => ({ ...result, path: plain(result.path) })) } : {}),
			...(response.errors ? { errors: response.errors.map(error => ({ ...error, path: plain(error.path) })) } : {}) };
	}

	async previewFileVersion(version: RemoteFileVersion): Promise<ArrayBuffer> {
		const wire = version.wire ?? await this.wireFor(version.path);
		const params = new URLSearchParams({ path: wire, storageKey: version.storage_key });
		let { body } = await this.http.requestBinary(`/sync/version-preview?${params}`, {}, TRANSFER_TIMEOUT_MS);
		if (this.encryption) body = (await this.encryption.download(wire, body, { expected: version.path, historical: true })).content;
		if (body.byteLength > MAX_PREVIEW_BYTES || body.byteLength !== version.size || await sha256Hex(body) !== version.hash) {
			throw new Error('Saved version failed integrity validation.');
		}
		return body;
	}

	async listFileVersions(query: FileVersionQuery = {}): Promise<FileVersionsPage> {
		const params = new URLSearchParams();
		if (query.path) params.set('path', await this.wireFor(query.path));
		// Encrypted names cannot be searched on the server.
		if (query.search && !this.encryption) params.set('search', query.search);
		if (query.cursor) params.set('cursor', query.cursor);
		const result = await requestFileVersions(this.http, params);
		if (!this.encryption) return result;
		const versions = await this.encryption.metadata(result.versions.map(version => ({ path: version.path,
			entry: { ...version, revision: version.storage_key } })), { historical: true });
		return { ...result, versions: versions.map(({ path, wire, entry: { revision: _revision, ...version } }) => ({ ...version, path, wire })) };
	}

	async restoreFileVersion(request: RestoreFileRequest): Promise<UploadResult> {
		return parseUploadResult(await this.http.requestJson<unknown>('/sync/restore-version', {
			method: 'POST',
			body: JSON.stringify(request),
			headers: { [UPLOAD_OPERATION_HEADER]: request.operationId },
		}));
	}
}

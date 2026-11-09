import type { ConnectionTestResult } from '../types';
import type { EncryptedFiles, UploadPreconditions } from '../encryption/encrypted-files';
import { assignPlainPaths, type WireStore } from '../encryption/path-index';
import type { JournalUpload } from '../durability/upload-intent';
import { ENCRYPTED_FILE_CONTENT_TYPE } from '../../encryption/file-format';
import { base64ToArrayBuffer } from '../encoding';
import type { RestoreIntent } from '../durability/restore-intent';
import type { RemoteFileVersion } from '../../protocol/sync-types';
import { BATCH_FILE_SIZE_LIMIT, BATCH_UPLOAD_MAX_FILES, BULK_NEW_UPLOAD_CAPABILITY, MAX_PREVIEW_BYTES } from '../../protocol/sync-limits';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { requestFileVersions } from './version-contract';
import { parseChanges, parseManifestPage, requestChangesCheck, requestFileMetadata } from './read-contracts';
import { errorMessage } from '../../platform/logger';
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
import { assertPortablePathNames, assertPortablePaths } from '../../protocol/portable-path';
import { createPathRecord, getPathEntry } from '../../protocol/path-record';
import { BATCH_DOWNLOAD_MAX_FILES } from '../../protocol/sync-limits';
import { FILE_HASH_HEADER, FILE_SIZE_HEADER, EXPECTED_HASH_HEADER, UPLOAD_OPERATION_HEADER, UPLOAD_OPERATIONS_HEADER, REVISION_HEADER } from '../../protocol/http-headers';
import {
	getHeader,
	TRANSFER_TIMEOUT_MS,
	transferTimeout,
	HttpError,
	type WorkerApiHttpClient,
} from './http';
import { sha256Hex } from '@/platform/sha256';

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
			// A rejected sealed note is reported, never mapped to a local file.
			if (entry.rejected) { plain[path] = entry; continue; }
			if (renamed) await encryption.paths.learn(path, wire);
			plain[path] = tagged[index] && !renamed ? entry : { ...entry, wire };
		}
		return plain;
	}

	private async wireFor(path: string): Promise<string> {
		return this.encryption ? this.encryption.paths.wireFor(path) : path;
	}

	/** Where the server stores `path`, when that is not its tag: a note the server sealed
	 * keeps its random name. Undefined in unencrypted vaults and for tagged paths. */
	async opaqueServerPath(path: string): Promise<string | undefined> {
		if (!this.encryption) return undefined;
		const wire = await this.encryption.paths.wireFor(path);
		return wire === await this.encryption.paths.tags.wire(path) ? undefined : wire;
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

	/** One raw manifest entry is enough to tell whether the server stores any file. */
	async hasFiles(): Promise<boolean> {
		const page = parseManifestPage(await this.http.requestJson<unknown>('/sync/manifest?limit=1'));
		return Object.keys(page.files).length > 0;
	}

	async getManifest(): Promise<FileManifest> {
		const files = createPathRecord<FileEntry>();
		let after: string | undefined;
		let snapshotSeq: number | undefined;
		let lastSeq = 0;
		const cursors = new Set<string>();
		while (true) {
			const params = new URLSearchParams({ limit: '2000' });
			if (after) params.set('after', after);
			if (snapshotSeq !== undefined) params.set('snapshotSeq', String(snapshotSeq));
			const page = parseManifestPage(await this.http.requestJson<unknown>(`/sync/manifest?${params.toString()}`));
			if (snapshotSeq !== undefined && page.snapshotSeq !== snapshotSeq) throw new Error('Remote manifest snapshot changed during pagination');
			if (Object.keys(page.files).some(path => Object.prototype.hasOwnProperty.call(files, path))) throw new Error('Remote manifest repeated a file during pagination');
			Object.assign(files, page.files);
			lastSeq = page.lastSeq ?? lastSeq;
			snapshotSeq ??= page.snapshotSeq ?? page.lastSeq ?? 0;
			if (!page.hasMore) break;
			if (!page.nextCursor || cursors.has(page.nextCursor)) {
				throw new Error('Remote manifest pagination did not advance');
			}
			after = page.nextCursor;
			cursors.add(after);
		}

		let changeCursor = snapshotSeq ?? lastSeq;
		while (true) {
			const changes = await this.getRawChanges(changeCursor);
			if (changes.cursorExpired) throw new Error('Remote manifest changed too quickly to load safely');
			for (const change of changes.changes) {
				if (change.action === 'delete') {
					delete files[change.path];
				} else {
					files[change.path] = {
						hash: change.hash,
						revision: change.revision,
						size: change.size,
						modified: change.created_at,
					};
				}
			}
			lastSeq = changes.lastSeq;
			if (!changes.hasMore || changes.changes.length === 0) break;
			changeCursor = changes.changes.at(-1)?.seq ?? changeCursor;
		}

		assertPortablePaths(Object.keys(files));
		return { version: 1, files: await this.decryptEntries(files), lastSeq };
	}

	async getFileMetadata(paths: string[]): Promise<FileMetadataResponse> {
		const requested = [...new Set(paths)];
		// Requested paths may include an old file and its replacement directory;
		// only returned live state must be a representable namespace.
		assertPortablePathNames(requested);
		const uniquePaths = [...new Set(await Promise.all(requested.map(path => this.wireFor(path))))];
		const files = createPathRecord<FileEntry>();

		for (let index = 0; index < uniquePaths.length; index += BATCH_DOWNLOAD_MAX_FILES) {
			const chunk = uniquePaths.slice(index, index + BATCH_DOWNLOAD_MAX_FILES);
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
		return this.http.requestJson<UploadResult>(`/sync/upload?path=${encodedPath}`, {
			method: 'PUT',
			body: content,
			headers: {
				[UPLOAD_OPERATION_HEADER]: operationId,
				'Content-Type': contentType,
				[FILE_HASH_HEADER]: hash,
				[FILE_SIZE_HEADER]: String(size),
				[EXPECTED_HASH_HEADER]: expectedHash === null ? 'absent' : expectedHash,
			},
		}, transferTimeout(content.byteLength));
	}

	private async newUploadOperationId(): Promise<string> {
		return createUploadOperationId(await this.getServerInfo());
	}

	/** `size`, when known, extends the timeout for a large file. */
	async downloadFile(path: string, size?: number): Promise<DownloadedFile> {
		const wire = await this.wireFor(path);
		const encodedPath = encodeURIComponent(wire);
		const { body, headers } = await this.http.requestBinary(`/sync/download?path=${encodedPath}`, {}, transferTimeout(size ?? 0));
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

	private async getRawChanges(since: number): Promise<ChangesResponse> {
		const response = parseChanges(await this.http.requestJson<unknown>(`/sync/changes?since=${since}`), since);
		assertPortablePathNames(response.changes.map(change => change.path));
		return response;
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
		if (files.length > BATCH_UPLOAD_MAX_FILES) {
			const results: BatchUploadResponse['results'] = [];
			for (let offset = 0; offset < files.length; offset += BATCH_UPLOAD_MAX_FILES) {
				results.push(...(await this.batchUpload(files.slice(offset, offset + BATCH_UPLOAD_MAX_FILES))).results);
			}
			return { success: results.every(result => result.success), results };
		}
		const bulkNew = !this.encryption && info.capabilities.includes(BULK_NEW_UPLOAD_CAPABILITY)
			&& files.every(file => file.expectedHash === null);

		const body = JSON.stringify({ files, ...(bulkNew ? { bulkNewFiles: true } : {}) });
		return this.http.requestJson<BatchUploadResponse>('/sync/batch-upload', {
			method: 'POST',
			body,
			headers: { [UPLOAD_OPERATIONS_HEADER]: files.map(file => file.operationId).join(',') },
		}, transferTimeout(body.length));
	}

	async batchDownload(paths: string[]): Promise<DownloadedBatch> {
		let response: BatchDownloadResponse;
		const wires = await Promise.all(paths.map(path => this.wireFor(path)));
		const plainByWire = new Map(wires.map((wire, index) => [wire, paths[index]!]));
		try { response = await this.http.requestJson<BatchDownloadResponse>('/sync/batch-download', {
			method: 'POST',
			body: JSON.stringify({ paths: wires }),
		}, TRANSFER_TIMEOUT_MS); }
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
		// Each sealed note is checked against the Reading folder's synced files; read them once.
		const synced = encryption.syncedSnapshot();
		const files = await runConcurrentTasks(response.files.map(({ content, ...file }) => async (): Promise<DownloadedBatchFile> => {
			const path = plainByWire.get(file.path) ?? file.path;
			if (file.error) return { ...file, path, content };
			const opened = await encryption.download(file.path, base64ToArrayBuffer(content), { check: file, expected: path, synced });
			return { ...file, ...opened.metadata, path, verifiedContent: opened.content };
		}), DECRYPT_CONCURRENCY, () => false);
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
		if (!this.encryption) return this.http.requestJson<BatchDeleteResponse>('/sync/batch-delete', { method: 'POST', body: JSON.stringify({ files }) });
		const hashes = await this.encryption.expectedHashes(files.map(file => ({ path: file.path, expected: file.expectedHash, revision: file.expectedRevision })));
		const wires = await Promise.all(files.map(file => this.wireFor(file.path)));
		const plain = (wire: string) => paths[wires.indexOf(wire)] ?? wire;
		const response = await this.http.requestJson<BatchDeleteResponse>('/sync/batch-delete', {
			method: 'POST',
			body: JSON.stringify({ files: files.map((file, index) => ({ ...file, path: wires[index]!, expectedHash: hashes[index]! })) }),
		});
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
		return this.http.requestJson('/sync/restore-version', {
			method: 'POST',
			body: JSON.stringify(request),
			headers: { [UPLOAD_OPERATION_HEADER]: request.operationId },
		});
	}
}

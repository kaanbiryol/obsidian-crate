import type { ConnectionTestResult } from '../types';
import type { EncryptedFiles, UploadPreconditions } from '../encryption/encrypted-files';
import type { WireStore } from '../encryption/path-index';
import type { JournalUpload } from '../durability/upload-intent';
import { ENCRYPTED_FILE_CONTENT_TYPE } from '../../encryption/file-format';
import { base64ToArrayBuffer } from '../encoding';
import type { RestoreIntent } from '../durability/restore-intent';
import type { RemoteFileVersion } from '../../protocol/sync-types';
import { BATCH_FILE_SIZE_LIMIT, BULK_NEW_UPLOAD_CAPABILITY, MAX_PREVIEW_BYTES, maxUploadBatchFiles } from '../../protocol/sync-limits';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { parseFileVersions } from './version-contract';
import { parseChanges, parseChangesCheck, parseFileMetadata, parseManifestPage } from './read-contracts';
import { errorMessage } from '../../platform/logger';
import { refusedUploadResult } from '../failures';
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
import { portablePathKey } from '../../protocol/portable-path';
import { BATCH_DOWNLOAD_MAX_FILES } from '../../protocol/sync-limits';
import { FILE_HASH_HEADER, FILE_SIZE_HEADER, EXPECTED_HASH_HEADER, UPLOAD_OPERATION_HEADER, UPLOAD_OPERATIONS_HEADER, REVISION_HEADER } from '../../protocol/http-headers';
import {
	getHeader,
	TRANSFER_TIMEOUT_MS,
	HttpError,
	type WorkerApiHttpClient,
} from './http';
import { sha256Hex } from '@/platform/sha256';

// Bounds decrypted plaintext held at once while overlapping batch decryption.
const DECRYPT_CONCURRENCY = 4;
/** With encryption, `content` is plaintext whose `hash` and `size` decryption verified. */
export interface DownloadedFile { content: ArrayBuffer; contentType: string; size: number; hash: string; revision?: string; verified?: true }
type BatchDownloadEntry = BatchDownloadResponse['files'][number];
/** Client-side batch entries: decrypted files carry verified bytes instead of base64. */
type DownloadedBatchFile = BatchDownloadEntry | (Omit<BatchDownloadEntry, 'content'> & { verifiedContent: ArrayBuffer });
export interface DownloadedBatch { files: DownloadedBatchFile[] }

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
		const plain = createPathRecord<FileEntry>(), claimed = new Set<string>();
		const order = entries.map((_, index) => index).sort((a, b) => Number(tagged[b]) - Number(tagged[a]));
		for (const index of order) {
			const { wire, entry } = entries[index]!;
			let { path } = entries[index]!;
			if (claimed.has(portablePathKey(path))) {
				const name = path.lastIndexOf('/') + 1, dot = path.lastIndexOf('.') > name ? path.lastIndexOf('.') : path.length;
				path = `${path.slice(0, dot)} - ${wire.slice(wire.lastIndexOf('/') + 1, wire.lastIndexOf('/') + 9)}${path.slice(dot)}`;
				await encryption.paths.learn(path, wire);
			}
			claimed.add(portablePathKey(path));
			plain[path] = tagged[index] && path === entries[index]!.path ? entry : { ...entry, wire };
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
			const response = parseFileMetadata(await this.http.requestJson<unknown>('/sync/metadata', {
				method: 'POST',
				body: JSON.stringify({ paths: chunk }),
			}), chunk);
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
		}, TRANSFER_TIMEOUT_MS);
	}

	private async newUploadOperationId(): Promise<string> {
		const day = (await this.getServerInfo()).reminderOperationDay;
		if (day === undefined) throw new Error('Update the Crate server before uploading');
		return createReminderOperationId(day);
	}

	async downloadFile(path: string): Promise<DownloadedFile> {
		const wire = await this.wireFor(path);
		const encodedPath = encodeURIComponent(wire);
		const { body, headers } = await this.http.requestBinary(`/sync/download?path=${encodedPath}`, {}, TRANSFER_TIMEOUT_MS);
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
		const opened = await this.encryption.download(wire, body, result, path);
		return { ...result, content: opened.content, ...opened.metadata, verified: true };
	}

	async checkForChanges(since: number): Promise<CheckResponse> {
		return parseChangesCheck(await this.http.requestJson<unknown>(`/sync/check?since=${since}`), since);
	}

	async getChanges(since: number): Promise<ChangesResponse> {
		const response = await this.getRawChanges(since);
		if (!this.encryption) return response;
		const puts = response.changes.filter(change => change.action === 'put');
		const opened = await this.encryption.metadata(puts.map(entry => ({ path: entry.path, entry })));
		let index = 0;
		const changes: ChangelogEntry[] = [];
		for (const change of response.changes) {
			if (change.action === 'put') { const { path, entry } = opened[index++]!; changes.push({ ...entry, path }); continue; }
			// A deleted server path this device never synced has no local file to remove.
			const path = await this.encryption.paths.plainFor(change.path);
			if (path) changes.push({ ...change, path });
		}
		return { ...response, changes };
	}

	private async getRawChanges(since: number): Promise<ChangesResponse> {
		const response = parseChanges(await this.http.requestJson<unknown>(`/sync/changes?since=${since}`), since);
		assertPortablePathNames(response.changes.map(change => change.path));
		return response;
	}

	async batchUpload(files: BatchUploadFile[]): Promise<BatchUploadResponse> {
		for (const file of files) this.assertWireContentType(file.contentType);
		if (this.encryption && (files.some(file => file.size > BATCH_FILE_SIZE_LIMIT) || files.reduce((bytes, file) => bytes + file.size, 0) > 8 * 1024 * 1024)) {
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
			const day = info.reminderOperationDay;
			if (day === undefined) throw new Error('Update the Crate server before uploading');
			files = files.map(file => ({ ...file, operationId: file.operationId ?? createReminderOperationId(day) }));
		}
		const bulkNewEligible = !this.encryption && info.capabilities.includes(BULK_NEW_UPLOAD_CAPABILITY);
		const bulkNew = bulkNewEligible && files.every(file => file.expectedHash === null);
		const maxFiles = maxUploadBatchFiles(files, bulkNewEligible);
		if (files.length > maxFiles) {
			const results: BatchUploadResponse['results'] = [];
			for (let offset = 0; offset < files.length; offset += maxFiles) {
				results.push(...(await this.batchUpload(files.slice(offset, offset + maxFiles))).results);
			}
			return { success: results.every(result => result.success), results };
		}

		return this.http.requestJson<BatchUploadResponse>('/sync/batch-upload', {
			method: 'POST',
			body: JSON.stringify({ files, ...(bulkNew ? { bulkNewFiles: true } : {}) }),
			headers: { [UPLOAD_OPERATIONS_HEADER]: files.map(file => file.operationId).join(',') },
		}, TRANSFER_TIMEOUT_MS);
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
		const files = new Array<DownloadedBatchFile>(response.files.length);
		let next = 0;
		const worker = async () => {
			while (next < response.files.length) {
				const index = next++;
				const { content, ...file } = response.files[index]!;
				const path = plainByWire.get(file.path) ?? file.path;
				if (file.error) { files[index] = { ...file, path, content }; continue; }
				const opened = await encryption.download(file.path, base64ToArrayBuffer(content), file, path);
				files[index] = { ...file, ...opened.metadata, path, verifiedContent: opened.content };
			}
		};
		await Promise.all(Array.from({ length: Math.min(DECRYPT_CONCURRENCY, response.files.length) }, worker));
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
		if (this.encryption) body = (await this.encryption.download(wire, body, undefined, version.path, false)).content;
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
		const result = parseFileVersions(await this.http.requestJson<unknown>(`/sync/versions?${params.toString()}`));
		if (!this.encryption) return result;
		const versions = await this.encryption.metadata(result.versions.map(version => ({ path: version.path,
			entry: { ...version, revision: version.storage_key } })), false);
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

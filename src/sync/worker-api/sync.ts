import { computeHash } from '../hasher';
import type { EncryptedFiles } from '../encrypted-files';
import type { JournalUpload } from '../upload-intent';
import { ENCRYPTED_FILE_CONTENT_TYPE, parseEncryptedFile } from '../../encryption/file-format';
import { arrayBufferToBase64, base64ToArrayBuffer } from '../encoding';
import type { RestoreIntent } from '../restore-intent';
import type { RemoteFileVersion } from '../../protocol/sync-types';
import { BATCH_FILE_SIZE_LIMIT, BATCH_UPLOAD_MAX_FILES, BATCH_ASSET_UPLOAD_CAPABILITY, BULK_NEW_UPLOAD_CAPABILITY, BULK_NEW_UPLOAD_MAX_FILES, BATCH_ASSET_UPLOAD_MAX_FILES } from '../../protocol/sync-limits';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { parseFileVersions } from './version-contract';
import { parseChanges, parseChangesCheck, parseFileMetadata, parseManifestPage } from './read-contracts';
import { errorMessage } from '../../plugin/logger';
import type {
	BatchDeleteResponse,
	BatchDeleteFile,
	BatchDownloadResponse,
	BatchUploadFile,
	BatchUploadResponse,
	BackendDiagnostics,
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
} from '../../protocol';
import { assertPortablePathNames, assertPortablePaths } from '../../protocol/portable-path';
import { createPathRecord, getPathEntry } from '../../protocol/path-record';
import { BATCH_DOWNLOAD_MAX_FILES } from '../../protocol/sync-limits';
import {
	getHeader,
	TRANSFER_TIMEOUT_MS,
	HttpError,
	type WorkerApiHttpClient,
} from './http';

export class SyncWorkerApi {
	constructor(private readonly http: WorkerApiHttpClient) {}
	private encryption?: EncryptedFiles;
	setEncryption(encryption: EncryptedFiles): void { this.encryption = encryption; }
	prepareUploadWire(file: JournalUpload) { return this.encryption?.prepare(file) ?? Promise.resolve(undefined); }
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
	private async decryptEntries(files: Record<string, FileEntry>): Promise<Record<string, FileEntry>> {
		if (!this.encryption) return files;
		const paths = Object.keys(files);
		const entries = await this.encryption.metadata(paths.map(path => ({ path, entry: files[path]! })));
		return Object.fromEntries(paths.map((path, index) => [path, entries[index]!]));
	}

	async health(): Promise<HealthResponse> {
		return this.http.requestJson<HealthResponse>('/health');
	}

	async getServerInfo(): Promise<CrateServerInfo> {
		return this.http.getServerInfo();
	}

	async testConnection(): Promise<{ success: boolean; error?: string }> {
		try {
			const info = await this.getServerInfo();
			if (!isCompatibleCrateServer(info)) {
				return {
					success: false,
					error: `Incompatible Crate server protocol ${info.protocol.current}`,
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
		const uniquePaths = [...new Set(paths)];
		// Requested paths may include an old file and its replacement directory;
		// only returned live state must be a representable namespace.
		assertPortablePathNames(uniquePaths);
		const files = createPathRecord<FileEntry>();

		for (let index = 0; index < uniquePaths.length; index += BATCH_DOWNLOAD_MAX_FILES) {
			const chunk = uniquePaths.slice(index, index + BATCH_DOWNLOAD_MAX_FILES);
			try {
				const response = parseFileMetadata(await this.http.requestJson<unknown>('/sync/metadata', {
					method: 'POST',
					body: JSON.stringify({ paths: chunk }),
				}), chunk);
				Object.assign(files, response.files);
			} catch (error) {
				if (!(error instanceof HttpError) || error.status !== 404) throw error;
				const manifest = await this.getManifest();
				const fallbackFiles = createPathRecord<FileEntry>();
				for (const path of uniquePaths) {
					const entry = getPathEntry(manifest.files, path);
					if (entry) fallbackFiles[path] = entry;
				}
				return { files: fallbackFiles };
			}
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
				'X-Crate-Upload-Operation': operationId,
				'Content-Type': contentType,
				'X-File-Hash': hash,
				'X-File-Size': String(size),
				'X-Crate-Expected-Hash': expectedHash === null ? 'absent' : expectedHash,
			},
		}, TRANSFER_TIMEOUT_MS);
	}

	private async newUploadOperationId(): Promise<string> {
		const day = (await this.getServerInfo()).reminderOperationDay;
		if (day === undefined) throw new Error('Update the Crate server before uploading');
		return createReminderOperationId(day);
	}

	async downloadFile(path: string): Promise<{ content: ArrayBuffer; contentType: string; size: number; hash: string; revision?: string }> {
		const encodedPath = encodeURIComponent(path);
		const { body, headers } = await this.http.requestBinary(`/sync/download?path=${encodedPath}`, {}, TRANSFER_TIMEOUT_MS);
		const contentLengthHeader = getHeader(headers, 'Content-Length');
		const contentLength = contentLengthHeader && /^\d+$/.test(contentLengthHeader)
			? Number(contentLengthHeader)
			: body.byteLength;
		const result = {
			content: body,
			contentType: getHeader(headers, 'Content-Type') || 'application/octet-stream',
			size: Number.isSafeInteger(contentLength) ? contentLength : body.byteLength,
			hash: getHeader(headers, 'X-File-Hash') || '',
			revision: getHeader(headers, 'X-Crate-Revision') || undefined,
		};
		if (!this.encryption) return result;
		const opened = await this.encryption.download(path, body, result);
		return { ...result, content: opened.content, ...opened.metadata };
	}

	async deleteFile(path: string, expectedHash: string, expectedRevision?: string): Promise<{ success: boolean; path: string }> {
		if (!expectedRevision) throw new HttpError('Missing remote revision; reconcile before deleting', 409, null, 'version_conflict');
		if (this.encryption) expectedHash = (await this.encryption.expectedHash(path, expectedHash, expectedRevision))!;
		return this.http.requestJson<{ success: boolean; path: string }>('/sync/delete', {
			method: 'POST',
			body: JSON.stringify({ path, expectedHash, expectedRevision }),
		});
	}
	requiresLegacyUploadRecovery(file: JournalUpload): boolean { return !!this.encryption && file.encryptedWire?.generation !== this.encryption.generation; }
	async resolveLegacyUpload(file: JournalUpload): Promise<UploadResult | null> {
		if (!this.encryption || file.encryptedWire?.generation === this.encryption.generation) return null;
		const wire = file.encryptedWire;
		if (!wire) return this.encryption.resolveLegacyOperation(file.operationId,
			{ path: file.path, hash: file.hash, size: file.size, contentType: file.contentType, expectedHash: file.expectedHash });
		if (wire.generation !== undefined && wire.generation > this.encryption.generation) throw new Error('Unlock the original vault keys before resuming this upload');
		const descriptor = parseEncryptedFile(new Uint8Array(base64ToArrayBuffer(wire.content))).descriptor;
		if (descriptor.vaultId !== this.encryption.keys.vaultId) throw new Error('Unlock the original vault keys before resuming this upload');
		const current = this.encryption.keys.forPath(file.path);
		const payload = { path: file.path, hash: wire.hash, size: wire.size, contentType: wire.contentType, expectedHash: wire.expectedHash };
		// A generation fence proves that an older in-flight write can no longer
		// commit. Recover its exact receipt, or reconcile without replaying it.
		if (wire.generation !== undefined || descriptor.scopeId !== current.scopeId || descriptor.keyId !== current.key.id) {
			return this.encryption.resolveLegacyOperation(file.operationId, payload);
		}
		// Older journal formats do not record generation. Only a converted receipt
		// proves settlement; otherwise retain their normal exact-body retry.
		return this.encryption.resolveLegacyOperation(file.operationId, payload, true);
	}
	async resolveLegacyRestore(intent: RestoreIntent): Promise<UploadResult | null> {
		if (!this.encryption || intent.encryptedWire?.generation === this.encryption.generation) return null;
		if (intent.encryptedWire && (intent.encryptedWire.vaultId !== this.encryption.keys.vaultId || intent.encryptedWire.generation > this.encryption.generation)) throw new Error('Unlock the original vault keys before resuming this restore');
		const request = intent.request;
		const result = await this.encryption.resolveLegacyOperation(request.operationId, { kind: 'restore', path: request.path,
			storageKey: request.storageKey, expectedHash: intent.encryptedWire ? intent.encryptedWire.expectedHash : request.expectedHash, expectedRevision: request.expectedRevision });
		if (!result.success) throw new HttpError(result.error ?? 'Restore precondition changed', result.status ?? 409, null, result.code);
		return result;
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
		return { ...response, changes: response.changes.map(change => change.action === 'put' ? opened[index++]! : change) };
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
			for (const file of files) results.push(await this.uploadFile(file.path, base64ToArrayBuffer(file.content), file.hash,
				file.size, file.contentType, file.expectedHash, file.operationId));
			return { success: results.every(result => result.success), results };
		}
		if (files.some(file => !file.operationId)) {
			const day = (await this.getServerInfo()).reminderOperationDay;
			if (day === undefined) throw new Error('Update the Crate server before uploading');
			files = files.map(file => ({ ...file, operationId: file.operationId ?? createReminderOperationId(day) }));
		}
		const info = await this.getServerInfo();
		const bulkNew = !this.encryption && files.every(file => file.expectedHash === null) && info.capabilities.includes(BULK_NEW_UPLOAD_CAPABILITY);
		const maxFiles = bulkNew ? BULK_NEW_UPLOAD_MAX_FILES
			: files.every(file => !file.path.toLowerCase().endsWith('.md')) && info.capabilities.includes(BATCH_ASSET_UPLOAD_CAPABILITY)
				? BATCH_ASSET_UPLOAD_MAX_FILES : BATCH_UPLOAD_MAX_FILES;
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
			headers: { 'X-Crate-Upload-Operations': files.map(file => file.operationId).join(',') },
		}, TRANSFER_TIMEOUT_MS);
	}

	async batchDownload(paths: string[]): Promise<BatchDownloadResponse> {
		let response: BatchDownloadResponse;
		try { response = await this.http.requestJson<BatchDownloadResponse>('/sync/batch-download', {
			method: 'POST',
			body: JSON.stringify({ paths }),
		}, TRANSFER_TIMEOUT_MS); }
		catch (error) {
			if (!this.encryption || !(error instanceof HttpError) || error.status !== 413) throw error;
			const files: BatchDownloadResponse['files'] = [];
			for (const path of paths) {
				const file = await this.downloadFile(path);
				files.push({ ...file, path, content: arrayBufferToBase64(file.content) });
			}
			return { files };
		}
		if (!this.encryption) return response;
		const files: BatchDownloadResponse['files'] = [];
		for (const file of response.files) {
			if (file.error) { files.push(file); continue; }
			const opened = await this.encryption.download(file.path, base64ToArrayBuffer(file.content), file);
			files.push({ ...file, ...opened.metadata, content: arrayBufferToBase64(opened.content) });
		}
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
		if (this.encryption) {
			for (const file of files) file.expectedHash = (await this.encryption.expectedHash(file.path, file.expectedHash, file.expectedRevision))!;
		}
		return this.http.requestJson<BatchDeleteResponse>('/sync/batch-delete', {
			method: 'POST',
			body: JSON.stringify({ files }),
		});
	}

	async previewFileVersion(version: RemoteFileVersion): Promise<ArrayBuffer> {
		const params = new URLSearchParams({ path: version.path, storageKey: version.storage_key });
		let { body } = await this.http.requestBinary(`/sync/version-preview?${params}`, {}, TRANSFER_TIMEOUT_MS);
		if (this.encryption) body = (await this.encryption.download(version.path, body)).content;
		if (body.byteLength > 256_000 || body.byteLength !== version.size || await computeHash(body) !== version.hash) {
			throw new Error('Saved version failed integrity validation.');
		}
		return body;
	}

	async listFileVersions(query: FileVersionQuery = {}): Promise<FileVersionsPage> {
		const params = new URLSearchParams();
		if (query.path) params.set('path', query.path);
		if (query.search) params.set('search', query.search);
		if (query.cursor) params.set('cursor', query.cursor);
		const result = parseFileVersions(await this.http.requestJson<unknown>(`/sync/versions?${params.toString()}`));
		if (!this.encryption) return result;
		return { ...result, versions: await this.encryption.metadata(result.versions.map(version => ({ path: version.path,
			entry: { ...version, revision: version.storage_key } }))) };
	}

	async restoreFileVersion(request: RestoreFileRequest): Promise<UploadResult> {
		return this.http.requestJson('/sync/restore-version', {
			method: 'POST',
			body: JSON.stringify(request),
			headers: { 'X-Crate-Upload-Operation': request.operationId },
		});
	}
}

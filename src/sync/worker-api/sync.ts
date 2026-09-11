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
	parseCrateServerInfo,
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

	async health(): Promise<HealthResponse> {
		return this.http.requestJson<HealthResponse>('/health');
	}

	async getServerInfo(): Promise<CrateServerInfo> {
		const value = await this.http.requestJson<unknown>('/.well-known/crate');
		const info = parseCrateServerInfo(value);
		if (!info) {
			throw new Error('Server returned invalid Crate compatibility metadata');
		}
		return info;
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
			const changes = await this.getChanges(changeCursor);
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
		return { version: 1, files, lastSeq };
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

		return { files };
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
		return {
			content: body,
			contentType: getHeader(headers, 'Content-Type') || 'application/octet-stream',
			size: Number.isSafeInteger(contentLength) ? contentLength : body.byteLength,
			hash: getHeader(headers, 'X-File-Hash') || '',
			revision: getHeader(headers, 'X-Crate-Revision') || undefined,
		};
	}

	async deleteFile(path: string, expectedHash: string, expectedRevision?: string): Promise<{ success: boolean; path: string }> {
		if (!expectedRevision) throw new HttpError('Missing remote revision; reconcile before deleting', 409, null, 'version_conflict');
		return this.http.requestJson<{ success: boolean; path: string }>('/sync/delete', {
			method: 'POST',
			body: JSON.stringify({ path, expectedHash, expectedRevision }),
		});
	}

	async checkForChanges(since: number): Promise<CheckResponse> {
		return parseChangesCheck(await this.http.requestJson<unknown>(`/sync/check?since=${since}`), since);
	}

	async getChanges(since: number): Promise<ChangesResponse> {
		const response = parseChanges(await this.http.requestJson<unknown>(`/sync/changes?since=${since}`), since);
		assertPortablePathNames(response.changes.map(change => change.path));
		return response;
	}

	async batchUpload(files: BatchUploadFile[]): Promise<BatchUploadResponse> {
		if (files.some(file => !file.operationId)) {
			const day = (await this.getServerInfo()).reminderOperationDay;
			if (day === undefined) throw new Error('Update the Crate server before uploading');
			files = files.map(file => ({ ...file, operationId: file.operationId ?? createReminderOperationId(day) }));
		}
		return this.http.requestJson<BatchUploadResponse>('/sync/batch-upload', {
			method: 'POST',
			body: JSON.stringify({ files }),
			headers: { 'X-Crate-Upload-Operations': files.map(file => file.operationId).join(',') },
		}, TRANSFER_TIMEOUT_MS);
	}

	async batchDownload(paths: string[]): Promise<BatchDownloadResponse> {
		return this.http.requestJson<BatchDownloadResponse>('/sync/batch-download', {
			method: 'POST',
			body: JSON.stringify({ paths }),
		}, TRANSFER_TIMEOUT_MS);
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
		return this.http.requestJson<BatchDeleteResponse>('/sync/batch-delete', {
			method: 'POST',
			body: JSON.stringify({ files }),
		});
	}

	async listFileVersions(query: FileVersionQuery = {}): Promise<FileVersionsPage> {
		const params = new URLSearchParams();
		if (query.path) params.set('path', query.path);
		if (query.search) params.set('search', query.search);
		if (query.cursor) params.set('cursor', query.cursor);
		return parseFileVersions(await this.http.requestJson<unknown>(`/sync/versions?${params.toString()}`));
	}

	async restoreFileVersion(request: RestoreFileRequest): Promise<UploadResult> {
		return this.http.requestJson('/sync/restore-version', {
			method: 'POST',
			body: JSON.stringify(request),
			headers: { 'X-Crate-Upload-Operation': request.operationId },
		});
	}
}

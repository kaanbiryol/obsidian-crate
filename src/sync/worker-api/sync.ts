import { errorMessage } from '../../plugin/logger';
import type {
	BatchDeleteResponse,
	BatchDeleteFile,
	BatchDownloadResponse,
	BatchUploadFile,
	BatchUploadResponse,
	ChangesResponse,
	CheckResponse,
	FileManifest,
	HealthResponse,
	UploadResult,
} from '../../plugin/types';
import {
	isCompatibleCrateServer,
	parseCrateServerInfo,
	type CrateServerInfo,
} from '../../protocol';
import {
	getHeader,
	TRANSFER_TIMEOUT_MS,
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

	async getManifest(): Promise<FileManifest> {
		const manifest = await this.http.requestJson<FileManifest>('/sync/manifest');
		if (manifest.truncated) {
			throw new Error('Remote manifest is too large to sync safely');
		}
		return manifest;
	}

	async uploadFile(
		path: string,
		content: ArrayBuffer,
		hash: string,
		size: number,
		contentType: string,
		expectedHash: string | null,
	): Promise<UploadResult> {
		const encodedPath = encodeURIComponent(path);
		return this.http.requestJson<UploadResult>(`/sync/upload?path=${encodedPath}`, {
			method: 'PUT',
			body: content,
			headers: {
				'Content-Type': contentType,
				'X-File-Hash': hash,
				'X-File-Size': String(size),
				'X-Crate-Expected-Hash': expectedHash === null ? 'absent' : expectedHash,
			},
		}, TRANSFER_TIMEOUT_MS);
	}

	async downloadFile(path: string): Promise<{ content: ArrayBuffer; contentType: string; size: number; hash: string }> {
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
		};
	}

	async deleteFile(path: string, expectedHash: string): Promise<{ success: boolean; path: string }> {
		return this.http.requestJson<{ success: boolean; path: string }>('/sync/delete', {
			method: 'POST',
			body: JSON.stringify({ path, expectedHash }),
		});
	}

	async checkForChanges(since: number): Promise<CheckResponse> {
		return this.http.requestJson<CheckResponse>(`/sync/check?since=${since}`);
	}

	async getChanges(since: number): Promise<ChangesResponse> {
		return this.http.requestJson<ChangesResponse>(`/sync/changes?since=${since}`);
	}

	async batchUpload(files: BatchUploadFile[]): Promise<BatchUploadResponse> {
		return this.http.requestJson<BatchUploadResponse>('/sync/batch-upload', {
			method: 'POST',
			body: JSON.stringify({ files }),
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
	): Promise<BatchDeleteResponse> {
		const files: BatchDeleteFile[] = paths.map((path) => {
			const expectedHash = expectedHashes[path];
			if (!expectedHash) {
				throw new Error(`Missing expected remote hash for delete: ${path}`);
			}
			return { path, expectedHash };
		});
		return this.http.requestJson<BatchDeleteResponse>('/sync/batch-delete', {
			method: 'POST',
			body: JSON.stringify({ files }),
		});
	}
}

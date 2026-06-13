import { errorMessage } from '../../plugin/logger';
import type {
	BatchDeleteResponse,
	BatchDownloadResponse,
	BatchUploadFile,
	BatchUploadResponse,
	ChangesResponse,
	CheckResponse,
	FileManifest,
	HealthResponse,
	UploadResult,
	WorkerConfig,
} from '../../plugin/types';
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

	async testConnection(): Promise<{ success: boolean; error?: string }> {
		try {
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
		return this.http.requestJson<FileManifest>('/sync/manifest');
	}

	async uploadFile(
		path: string,
		content: ArrayBuffer,
		hash: string,
		size: number,
		contentType: string,
	): Promise<UploadResult> {
		const encodedPath = encodeURIComponent(path);
		return this.http.requestJson<UploadResult>(`/sync/upload?path=${encodedPath}`, {
			method: 'PUT',
			body: content,
			headers: {
				'Content-Type': contentType,
				'X-File-Hash': hash,
				'X-File-Size': String(size),
			},
		}, TRANSFER_TIMEOUT_MS);
	}

	async downloadFile(path: string): Promise<{ content: ArrayBuffer; contentType: string; size: number }> {
		const encodedPath = encodeURIComponent(path);
		const { body, headers } = await this.http.requestBinary(`/sync/download?path=${encodedPath}`, {}, TRANSFER_TIMEOUT_MS);
		return {
			content: body,
			contentType: getHeader(headers, 'Content-Type') || 'application/octet-stream',
			size: body.byteLength,
		};
	}

	async deleteFile(path: string): Promise<{ success: boolean; path: string }> {
		return this.http.requestJson<{ success: boolean; path: string }>('/sync/delete', {
			method: 'POST',
			body: JSON.stringify({ path }),
		});
	}

	async checkForChanges(since: number): Promise<CheckResponse> {
		return this.http.requestJson<CheckResponse>(`/sync/check?since=${since}`);
	}

	async getChanges(since: number): Promise<ChangesResponse> {
		return this.http.requestJson<ChangesResponse>(`/sync/changes?since=${since}`);
	}

	async getConfig(): Promise<WorkerConfig> {
		return this.http.requestJson<WorkerConfig>('/sync/config');
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

	async batchDelete(paths: string[]): Promise<BatchDeleteResponse> {
		return this.http.requestJson<BatchDeleteResponse>('/sync/batch-delete', {
			method: 'POST',
			body: JSON.stringify({ paths }),
		});
	}
}

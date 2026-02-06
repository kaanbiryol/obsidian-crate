/**
 * Worker API client for sync operations
 */

import { createLogger } from '../logger';
import type {
	FileManifest,
	TombstoneStore,
	UploadFile,
	UploadResponse,
	DownloadResponse,
	BatchDownloadResponse,
	HealthResponse,
	ChangesResponse,
	CheckResponse,
} from '../types';

const logger = createLogger('ApiClient');

export class SyncApiClient {
	private workerUrl: string;
	private authToken: string;

	constructor(workerUrl: string, authToken: string) {
		this.workerUrl = workerUrl.replace(/\/$/, ''); // Remove trailing slash
		this.authToken = authToken;
	}

	/**
	 * Update credentials (e.g., after settings change)
	 */
	updateCredentials(workerUrl: string, authToken: string): void {
		this.workerUrl = workerUrl.replace(/\/$/, '');
		this.authToken = authToken;
	}

	/**
	 * Check if API is configured
	 */
	isConfigured(): boolean {
		return this.workerUrl.length > 0 && this.authToken.length > 0;
	}

	/**
	 * Make authenticated request to worker
	 */
	private async request<T>(
		path: string,
		options: RequestInit = {}
	): Promise<T> {
		const url = `${this.workerUrl}${path}`;
		logger.info(`${options.method ?? 'GET'} ${path}`);

		const response = await fetch(url, {
			...options,
			headers: {
				'Authorization': `Bearer ${this.authToken}`,
				'Content-Type': 'application/json',
				...options.headers,
			},
		});

		if (!response.ok) {
			const errorBody = await response.text();
			let errorMessage: string;
			try {
				const errorJson = JSON.parse(errorBody) as { error?: string };
				errorMessage = errorJson.error || `HTTP ${response.status}`;
			} catch {
				errorMessage = `HTTP ${response.status}: ${errorBody}`;
			}
			logger.error(`Request failed: ${options.method ?? 'GET'} ${path} — ${errorMessage}`);
			throw new Error(errorMessage);
		}

		logger.info(`${options.method ?? 'GET'} ${path} → ${response.status}`);
		return response.json() as Promise<T>;
	}

	/**
	 * Health check
	 */
	async health(): Promise<HealthResponse> {
		return this.request<HealthResponse>('/health');
	}

	/**
	 * Test connection to worker
	 */
	async testConnection(): Promise<{ success: boolean; error?: string }> {
		try {
			const response = await this.health();
			return { success: response.status === 'ok' };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error',
			};
		}
	}

	/**
	 * Get remote manifest
	 */
	async getManifest(): Promise<FileManifest> {
		return this.request<FileManifest>('/sync/manifest');
	}

	/**
	 * Upload files to remote
	 */
	async uploadFiles(files: UploadFile[]): Promise<UploadResponse> {
		return this.request<UploadResponse>('/sync/upload', {
			method: 'POST',
			body: JSON.stringify({ files }),
		});
	}

	/**
	 * Download single file
	 */
	async downloadFile(path: string): Promise<DownloadResponse> {
		const encodedPath = encodeURIComponent(path);
		return this.request<DownloadResponse>(`/sync/download?path=${encodedPath}`);
	}

	/**
	 * Download multiple files
	 */
	async batchDownload(paths: string[]): Promise<BatchDownloadResponse> {
		return this.request<BatchDownloadResponse>('/sync/batch-download', {
			method: 'POST',
			body: JSON.stringify({ paths }),
		});
	}

	/**
	 * Delete file (creates tombstone)
	 */
	async deleteFile(path: string): Promise<{ success: boolean; path: string }> {
		return this.request<{ success: boolean; path: string }>('/sync/delete', {
			method: 'POST',
			body: JSON.stringify({ path }),
		});
	}

	/**
	 * Get tombstones
	 */
	async getTombstones(): Promise<TombstoneStore> {
		return this.request<TombstoneStore>('/sync/tombstones');
	}

	/**
	 * Lightweight check for remote changes (returns only seq, no row data)
	 */
	async checkForChanges(since: number): Promise<CheckResponse> {
		return this.request<CheckResponse>(`/sync/check?since=${since}`);
	}

	/**
	 * Get changelog entries since a given sequence number
	 */
	async getChanges(since: number): Promise<ChangesResponse> {
		return this.request<ChangesResponse>(`/sync/changes?since=${since}`);
	}
}

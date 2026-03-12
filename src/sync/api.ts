/**
 * Worker API client for sync operations
 */

import { createLogger } from '../logger';
import type {
	FileManifest,
	UploadResult,
	HealthResponse,
	ChangesResponse,
	CheckResponse,
	WorkerConfig,
	BatchUploadFile,
	BatchUploadResponse,
	BatchDownloadResponse,
	BatchDeleteResponse,
	SharedSettings,
} from '../types';

const logger = createLogger('ApiClient');

export class HttpError extends Error {
	constructor(message: string, readonly status: number, readonly retryAfter: number | null = null) {
		super(message);
		this.name = 'HttpError';
	}
}

function parseRetryAfter(response: Response): number | null {
	const header = response.headers.get('Retry-After');
	if (!header) return null;
	const seconds = parseInt(header, 10);
	return !isNaN(seconds) && seconds > 0 ? seconds * 1000 : null;
}

const TRANSFER_TIMEOUT_MS = 120_000;

export class SyncApiClient {
	private workerUrl: string;
	private authToken: string;
	private externalSignal: AbortSignal | undefined;

	constructor(workerUrl: string, authToken: string) {
		this.workerUrl = this.normalizeWorkerUrl(workerUrl);
		this.authToken = authToken;
	}

	/**
	 * Set an external abort signal to cancel all in-flight requests
	 */
	setAbortSignal(signal: AbortSignal): void {
		this.externalSignal = signal;
	}

	/**
	 * Update credentials (e.g., after settings change)
	 */
	updateCredentials(workerUrl: string, authToken: string): void {
		this.workerUrl = this.normalizeWorkerUrl(workerUrl);
		this.authToken = authToken;
	}

	private normalizeWorkerUrl(workerUrl: string): string {
		const raw = workerUrl.trim();
		if (!raw) return '';

		try {
			const parsed = new URL(raw);
			const isLocalhost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
			const isSecure = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLocalhost);
			if (!isSecure) {
				logger.warn(`Rejected worker URL with insecure protocol: ${parsed.protocol}`);
				return '';
			}
			return parsed.toString().replace(/\/$/, '');
		} catch {
			logger.warn('Rejected invalid worker URL');
			return '';
		}
	}

	/**
	 * Check if API is configured
	 */
	isConfigured(): boolean {
		return this.workerUrl.length > 0 && this.authToken.length > 0;
	}

	/**
	 * Make authenticated JSON request to worker
	 */
	private async requestJson<T>(
		path: string,
		options: RequestInit = {},
		timeout: number = 30_000,
	): Promise<T> {
		const url = `${this.workerUrl}${path}`;
		logger.info(`${options.method ?? 'GET'} ${path}`);

		const headers: Record<string, string> = {
			'Authorization': `Bearer ${this.authToken}`,
		};

		// Only set Content-Type to JSON if caller didn't provide explicit headers with Content-Type
		const callerHeaders = options.headers as Record<string, string> | undefined;
		if (!callerHeaders?.['Content-Type']) {
			headers['Content-Type'] = 'application/json';
		}

		const response = await fetch(url, {
			...options,
			signal: this.externalSignal
				? AbortSignal.any([AbortSignal.timeout(timeout), this.externalSignal])
				: AbortSignal.timeout(timeout),
			headers: {
				...headers,
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
			throw new HttpError(errorMessage, response.status, parseRetryAfter(response));
		}

		logger.info(`${options.method ?? 'GET'} ${path} → ${response.status}`);
		return response.json() as Promise<T>;
	}

	/**
	 * Make authenticated binary request to worker — returns raw ArrayBuffer + headers
	 */
	private async requestBinary(
		path: string,
		options: RequestInit = {},
		timeout: number = 30_000,
	): Promise<{ body: ArrayBuffer; headers: Headers }> {
		const url = `${this.workerUrl}${path}`;
		logger.info(`${options.method ?? 'GET'} ${path} (binary)`);

		const response = await fetch(url, {
			...options,
			signal: this.externalSignal
				? AbortSignal.any([AbortSignal.timeout(timeout), this.externalSignal])
				: AbortSignal.timeout(timeout),
			headers: {
				'Authorization': `Bearer ${this.authToken}`,
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
			throw new HttpError(errorMessage, response.status, parseRetryAfter(response));
		}

		logger.info(`${options.method ?? 'GET'} ${path} → ${response.status} (binary)`);
		return { body: await response.arrayBuffer(), headers: response.headers };
	}

	/**
	 * Health check
	 */
	async health(): Promise<HealthResponse> {
		return this.requestJson<HealthResponse>('/health');
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
		return this.requestJson<FileManifest>('/sync/manifest');
	}

	/**
	 * Upload a single file via binary PUT
	 */
	async uploadFile(
		path: string,
		content: ArrayBuffer,
		hash: string,
		size: number,
		contentType: string,
	): Promise<UploadResult> {
		const encodedPath = encodeURIComponent(path);
		return this.requestJson<UploadResult>(`/sync/upload?path=${encodedPath}`, {
			method: 'PUT',
			body: content,
			headers: {
				'Content-Type': contentType,
				'X-File-Hash': hash,
				'X-File-Size': String(size),
			},
		}, TRANSFER_TIMEOUT_MS);
	}

	/**
	 * Download single file — returns raw binary
	 */
	async downloadFile(path: string): Promise<{ content: ArrayBuffer; contentType: string; size: number }> {
		const encodedPath = encodeURIComponent(path);
		const { body, headers } = await this.requestBinary(`/sync/download?path=${encodedPath}`, {}, TRANSFER_TIMEOUT_MS);
		return {
			content: body,
			contentType: headers.get('Content-Type') || 'application/octet-stream',
			size: body.byteLength,
		};
	}

	/**
	 * Delete file
	 */
	async deleteFile(path: string): Promise<{ success: boolean; path: string }> {
		return this.requestJson<{ success: boolean; path: string }>('/sync/delete', {
			method: 'POST',
			body: JSON.stringify({ path }),
		});
	}

	/**
	 * Lightweight check for remote changes (returns only seq, no row data)
	 */
	async checkForChanges(since: number): Promise<CheckResponse> {
		return this.requestJson<CheckResponse>(`/sync/check?since=${since}`);
	}

	/**
	 * Get changelog entries since a given sequence number
	 */
	async getChanges(since: number): Promise<ChangesResponse> {
		return this.requestJson<ChangesResponse>(`/sync/changes?since=${since}`);
	}

	/**
	 * Get worker configuration (account/bucket/worker metadata)
	 */
	async getConfig(): Promise<WorkerConfig> {
		return this.requestJson<WorkerConfig>('/sync/config');
	}

	/**
	 * Batch upload multiple files (base64-encoded content)
	 */
	async batchUpload(files: BatchUploadFile[]): Promise<BatchUploadResponse> {
		return this.requestJson<BatchUploadResponse>('/sync/batch-upload', {
			method: 'POST',
			body: JSON.stringify({ files }),
		}, TRANSFER_TIMEOUT_MS);
	}

	/**
	 * Batch download multiple files (returns base64-encoded content)
	 */
	async batchDownload(paths: string[]): Promise<BatchDownloadResponse> {
		return this.requestJson<BatchDownloadResponse>('/sync/batch-download', {
			method: 'POST',
			body: JSON.stringify({ paths }),
		}, TRANSFER_TIMEOUT_MS);
	}

	/**
	 * Batch delete multiple files
	 */
	async batchDelete(paths: string[]): Promise<BatchDeleteResponse> {
		return this.requestJson<BatchDeleteResponse>('/sync/batch-delete', {
			method: 'POST',
			body: JSON.stringify({ paths }),
		});
	}

	/**
	 * Register a per-device auth token in D1
	 */
	async registerToken(tokenHash: string, deviceName?: string): Promise<{ id: string }> {
		return this.requestJson<{ id: string }>('/auth/tokens', {
			method: 'POST',
			body: JSON.stringify({ token_hash: tokenHash, device_name: deviceName }),
		});
	}

	/**
	 * Revoke an auth token by ID
	 */
	async revokeToken(id: string): Promise<{ success: boolean }> {
		return this.requestJson<{ success: boolean }>('/auth/tokens', {
			method: 'DELETE',
			body: JSON.stringify({ id }),
		});
	}

	/**
	 * List all registered auth tokens
	 */
	async listTokens(): Promise<{ tokens: Array<{ id: string; device_name: string | null; created_at: string }> }> {
		return this.requestJson<{ tokens: Array<{ id: string; device_name: string | null; created_at: string }> }>('/auth/tokens');
	}

	/**
	 * Get shared settings from R2
	 */
	async getSharedSettings(): Promise<{ settings: SharedSettings | null }> {
		return this.requestJson<{ settings: SharedSettings | null }>('/settings');
	}

	/**
	 * Put shared settings to R2
	 */
	async putSharedSettings(settings: SharedSettings): Promise<{ success: boolean }> {
		return this.requestJson<{ success: boolean }>('/settings', {
			method: 'PUT',
			body: JSON.stringify({ settings }),
		});
	}
}

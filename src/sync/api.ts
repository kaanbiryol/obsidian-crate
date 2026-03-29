/**
 * Worker API client for sync operations
 */

import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';
import { createLogger } from '../plugin/logger';
import { normalizeWorkerUrl } from './worker-url';
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
} from '../plugin/types';

const logger = createLogger('ApiClient');

export class HttpError extends Error {
	constructor(message: string, readonly status: number, readonly retryAfter: number | null = null) {
		super(message);
		this.name = 'HttpError';
	}
}

function getHeader(headers: Record<string, string>, headerName: string): string | null {
	const normalizedHeaderName = headerName.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === normalizedHeaderName) {
			return value;
		}
	}
	return null;
}

function parseRetryAfter(headers: Record<string, string>): number | null {
	const header = getHeader(headers, 'Retry-After');
	if (!header) return null;
	const seconds = parseInt(header, 10);
	return !isNaN(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function parseErrorMessage(status: number, responseText: string): string {
	try {
		const errorJson = JSON.parse(responseText) as { error?: string };
		return errorJson.error || `HTTP ${status}`;
	} catch {
		return `HTTP ${status}: ${responseText}`;
	}
}

function parseJsonResponse<T>(responseText: string, path: string): T {
	try {
		return JSON.parse(responseText) as T;
	} catch (error) {
		throw new Error(
			`Invalid JSON response for ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

const TRANSFER_TIMEOUT_MS = 120_000;
type ApiRequestOptions = Pick<RequestUrlParam, 'body' | 'contentType' | 'headers' | 'method'>;

export class SyncApiClient {
	private workerUrl: string;
	private authToken: string;
	private externalSignal: AbortSignal | undefined;

	constructor(workerUrl: string, authToken: string) {
		this.workerUrl = normalizeWorkerUrl(workerUrl);
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
		this.workerUrl = normalizeWorkerUrl(workerUrl);
		this.authToken = authToken;
	}

	/**
	 * Check if API is configured
	 */
	isConfigured(): boolean {
		return this.workerUrl.length > 0 && this.authToken.length > 0;
	}

	private async runRequest(
		path: string,
		options: ApiRequestOptions,
		timeout: number,
	): Promise<RequestUrlResponse> {
		const externalSignal = this.externalSignal;
		let timeoutId: ReturnType<typeof setTimeout> | null = null;
		let onAbort: (() => void) | null = null;

		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => {
				reject(new Error(`Request timed out after ${timeout}ms`));
			}, timeout);
		});

		const abortPromise = externalSignal
			? new Promise<never>((_, reject) => {
				if (externalSignal.aborted) {
					const error = new Error('Sync request aborted');
					error.name = 'AbortError';
					reject(error);
					return;
				}

				onAbort = () => {
					const error = new Error('Sync request aborted');
					error.name = 'AbortError';
					reject(error);
				};
				externalSignal.addEventListener('abort', onAbort, { once: true });
			})
			: null;

		const headersWithoutContentType = Object.fromEntries(
			Object.entries(options.headers ?? {}).filter(([key]) => key.toLowerCase() !== 'content-type'),
		);
		const resolvedContentType = options.contentType
			?? getHeader(options.headers ?? {}, 'Content-Type')
			?? undefined;

		const requestPromise = requestUrl({
			url: `${this.workerUrl}${path}`,
			method: options.method,
			body: options.body,
			contentType: resolvedContentType,
			headers: {
				Authorization: `Bearer ${this.authToken}`,
				...headersWithoutContentType,
			},
			throw: false,
		});

		try {
			return await Promise.race([
				requestPromise,
				timeoutPromise,
				...(abortPromise ? [abortPromise] : []),
			]);
		} finally {
			if (timeoutId !== null) {
				clearTimeout(timeoutId);
			}
			if (onAbort && externalSignal) {
				externalSignal.removeEventListener('abort', onAbort);
			}
		}
	}

	/**
	 * Make authenticated JSON request to worker
	 */
	private async requestJson<T>(
		path: string,
		options: ApiRequestOptions = {},
		timeout: number = 30_000,
	): Promise<T> {
		logger.info(`${options.method ?? 'GET'} ${path}`);
		const response = await this.runRequest(path, {
			...options,
			contentType: options.contentType ?? getHeader(options.headers ?? {}, 'Content-Type') ?? 'application/json',
		}, timeout);

		if (response.status >= 400) {
			const errorMessage = parseErrorMessage(response.status, response.text);
			logger.error(`Request failed: ${options.method ?? 'GET'} ${path} — ${errorMessage}`);
			throw new HttpError(errorMessage, response.status, parseRetryAfter(response.headers));
		}

		logger.info(`${options.method ?? 'GET'} ${path} → ${response.status}`);
		return parseJsonResponse<T>(response.text, path);
	}

	/**
	 * Make authenticated binary request to worker — returns raw ArrayBuffer + headers
	 */
	private async requestBinary(
		path: string,
		options: ApiRequestOptions = {},
		timeout: number = 30_000,
	): Promise<{ body: ArrayBuffer; headers: Record<string, string> }> {
		logger.info(`${options.method ?? 'GET'} ${path} (binary)`);
		const response = await this.runRequest(path, options, timeout);

		if (response.status >= 400) {
			const errorMessage = parseErrorMessage(response.status, response.text);
			logger.error(`Request failed: ${options.method ?? 'GET'} ${path} — ${errorMessage}`);
			throw new HttpError(errorMessage, response.status, parseRetryAfter(response.headers));
		}

		logger.info(`${options.method ?? 'GET'} ${path} → ${response.status} (binary)`);
		return { body: response.arrayBuffer, headers: response.headers };
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
			contentType: getHeader(headers, 'Content-Type') || 'application/octet-stream',
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

	// ---- Reminder scheduling ----

	async scheduleReminder(data: {
		reminderId: string;
		content: string;
		project?: string;
		dueDatetime: string;
		priority?: number;
	}): Promise<{ success: boolean }> {
		return this.requestJson<{ success: boolean }>('/reminders/schedule', {
			method: 'POST',
			body: JSON.stringify(data),
		});
	}

	async cancelReminder(reminderId: string): Promise<{ success: boolean }> {
		return this.requestJson<{ success: boolean }>('/reminders/cancel', {
			method: 'DELETE',
			body: JSON.stringify({ reminderId }),
		});
	}

	async getScheduledReminders(): Promise<{ scheduled: Array<{
		reminder_id: string;
		content: string;
		project: string | null;
		due_datetime: string;
	}> }> {
		return this.requestJson('/reminders/scheduled');
	}

	// ---- Push subscriptions ----

	async getPushSubscriptions(): Promise<{ subscriptions: Array<{
		id: string;
		device_name: string | null;
		created_at: string;
	}> }> {
		return this.requestJson('/notifications/subscriptions');
	}

	async deletePushSubscription(id: string): Promise<{ success: boolean }> {
		return this.requestJson<{ success: boolean }>('/notifications/subscribe', {
			method: 'DELETE',
			body: JSON.stringify({ id }),
		});
	}

	async testPush(): Promise<{ sent: number; failed: number; pruned: number; errors: string[] }> {
		return this.requestJson('/notifications/test', { method: 'POST' });
	}

}

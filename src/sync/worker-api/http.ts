import { createLogger, errorMessage } from '../../plugin/logger';
import { createAbortError } from '../abort';
import { normalizeWorkerUrl } from '../worker-url';

const logger = createLogger('ApiClient');

export const TRANSFER_TIMEOUT_MS = 120_000;

export interface ApiRequestOptions {
	body?: string | ArrayBuffer;
	contentType?: string;
	headers?: Record<string, string>;
	method?: string;
}

interface ApiHttpResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	text: string;
}

export class HttpError extends Error {
	constructor(message: string, readonly status: number, readonly retryAfter: number | null = null) {
		super(message);
		this.name = 'HttpError';
	}
}

export function getHeader(headers: Record<string, string>, headerName: string): string | null {
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

	const seconds = Number.parseInt(header, 10);
	if (!Number.isNaN(seconds) && seconds > 0) {
		return seconds * 1000;
	}

	const retryAt = Date.parse(header);
	if (Number.isNaN(retryAt)) {
		return null;
	}

	const delay = retryAt - Date.now();
	return delay > 0 ? delay : null;
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
			`Invalid JSON response for ${path}: ${errorMessage(error)}`,
		);
	}
}

export class WorkerApiHttpClient {
	private workerUrl: string;
	private authToken: string;
	private externalSignal: AbortSignal | undefined;

	constructor(workerUrl: string, authToken: string) {
		this.workerUrl = normalizeWorkerUrl(workerUrl);
		this.authToken = authToken;
	}

	setAbortSignal(signal: AbortSignal): void {
		this.externalSignal = signal;
	}

	updateCredentials(workerUrl: string, authToken: string): void {
		this.workerUrl = normalizeWorkerUrl(workerUrl);
		this.authToken = authToken;
	}

	isConfigured(): boolean {
		return this.workerUrl.length > 0 && this.authToken.length > 0;
	}

	getWorkerUrl(): string {
		return this.workerUrl;
	}

	private async runRequest(
		path: string,
		options: ApiRequestOptions,
		timeout: number,
	): Promise<ApiHttpResponse> {
		const externalSignal = this.externalSignal;
		if (externalSignal?.aborted) throw createAbortError('Sync request aborted');
		const controller = new AbortController();
		let timedOut = false;
		const onAbort = () => controller.abort();
		externalSignal?.addEventListener('abort', onAbort, { once: true });
		const timeoutId = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeout);

		const headersWithoutContentType = Object.fromEntries(
			Object.entries(options.headers ?? {}).filter(([key]) => key.toLowerCase() !== 'content-type'),
		);
		const resolvedContentType = options.contentType
			?? getHeader(options.headers ?? {}, 'Content-Type')
			?? undefined;

		try {
			const response = await globalThis.fetch(`${this.workerUrl}${path}`, {
				method: options.method,
				body: options.body,
				signal: controller.signal,
				headers: {
					Authorization: `Bearer ${this.authToken}`,
					...(resolvedContentType ? { 'Content-Type': resolvedContentType } : {}),
					...headersWithoutContentType,
				},
			});
			const arrayBuffer = await response.arrayBuffer();
			const responseHeaders: Record<string, string> = {};
			response.headers.forEach((value, key) => {
				responseHeaders[key] = value;
			});
			return {
				status: response.status,
				headers: responseHeaders,
				arrayBuffer,
				text: new TextDecoder().decode(arrayBuffer),
			};
		} catch (error) {
			if (externalSignal?.aborted) throw createAbortError('Sync request aborted');
			if (timedOut) throw new Error(`Request timed out after ${timeout}ms`);
			throw error;
		} finally {
			clearTimeout(timeoutId);
			externalSignal?.removeEventListener('abort', onAbort);
		}
	}

	async requestJson<T>(
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
			const message = parseErrorMessage(response.status, response.text);
			logger.error(`Request failed: ${options.method ?? 'GET'} ${path} -> ${message}`);
			throw new HttpError(message, response.status, parseRetryAfter(response.headers));
		}

		logger.info(`${options.method ?? 'GET'} ${path} -> ${response.status}`);
		return parseJsonResponse<T>(response.text, path);
	}

	async requestBinary(
		path: string,
		options: ApiRequestOptions = {},
		timeout: number = 30_000,
	): Promise<{ body: ArrayBuffer; headers: Record<string, string> }> {
		logger.info(`${options.method ?? 'GET'} ${path} (binary)`);
		const response = await this.runRequest(path, options, timeout);

		if (response.status >= 400) {
			const message = parseErrorMessage(response.status, response.text);
			logger.error(`Request failed: ${options.method ?? 'GET'} ${path} -> ${message}`);
			throw new HttpError(message, response.status, parseRetryAfter(response.headers));
		}

		logger.info(`${options.method ?? 'GET'} ${path} -> ${response.status} (binary)`);
		return { body: response.arrayBuffer, headers: response.headers };
	}
}

import { normalizeUploadOperationIds } from '../request-diagnostics';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER, isCompatibleCrateServer, isCrateMutation, parseCrateServerInfo } from '../../protocol';
import { requestUrl } from 'obsidian';
import { createLogger, errorMessage } from '../../plugin/logger';
import { createAbortError } from '../abort';
import { normalizeWorkerUrl } from '../worker-url';
import { diagnosticRoute, MAX_REQUEST_DIAGNOSTICS, normalizeRequestDiagnostics, type RequestDiagnostic, type RequestDiagnostics } from '../request-diagnostics';
import { isAbortError } from '../abort';

const logger = createLogger('ApiClient');

export const TRANSFER_TIMEOUT_MS = 120_000;

export interface ApiRequestOptions {
	body?: string | ArrayBuffer;
	contentType?: string;
	headers?: Record<string, string>;
	method?: string;
}

interface ApiHttpRequest extends ApiRequestOptions {
	url: string;
}

export interface ApiHttpResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	text: string;
}

export type ApiHttpTransport = (request: ApiHttpRequest) => Promise<ApiHttpResponse>;

const obsidianHttpTransport: ApiHttpTransport = async request => {
	const response = await requestUrl({
		url: request.url,
		method: request.method,
		body: request.body,
		contentType: request.contentType,
		headers: request.headers,
		throw: false,
	});
	return {
		status: response.status,
		headers: response.headers,
		arrayBuffer: response.arrayBuffer,
		text: response.text,
	};
};

export class HttpError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly retryAfter: number | null = null,
		readonly code?: string,
		readonly currentHash?: string | null,
		readonly requestId?: string,
	) {
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

function parseErrorDetails(status: number, responseText: string): {
	message: string;
	code?: string;
	currentHash?: string | null;
} {
	try {
		const errorJson = JSON.parse(responseText) as {
			error?: string;
			code?: string;
			currentHash?: string | null;
		};
		return {
			message: errorJson.error || `HTTP ${status}`,
			...(typeof errorJson.code === 'string' ? { code: errorJson.code } : {}),
			...('currentHash' in errorJson ? { currentHash: errorJson.currentHash ?? null } : {}),
		};
	} catch {
		return { message: `HTTP ${status}: ${responseText}` };
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
	private readonly clientSession = crypto.randomUUID();
	private requestDiagnostics: RequestDiagnostic[] = [];
	private workerUrl: string;
	private authToken: string;
	private externalSignal: AbortSignal | undefined;

	constructor(
		workerUrl: string,
		authToken: string,
		private readonly transport: ApiHttpTransport = obsidianHttpTransport,
	) {
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

	getRequestDiagnostics(): RequestDiagnostics {
		return normalizeRequestDiagnostics({ clientSession: this.clientSession, requests: this.requestDiagnostics })!;
	}

	private async runRequest(
		path: string,
		options: ApiRequestOptions,
		timeout: number,
	): Promise<ApiHttpResponse> {
		let protocol = CRATE_PLUGIN_PROTOCOL.current;
		if (isCrateMutation(path, options.method)) {
			const response = await this.runRequest('/.well-known/crate', {}, Math.min(timeout, 30_000));
			const info = response.status === 200 ? parseCrateServerInfo(parseJsonResponse<unknown>(response.text, '/.well-known/crate')) : null;
			if (!info || !isCompatibleCrateServer(info)) throw new HttpError('Update the Crate server before making changes', 428, null, 'protocol_incompatible');
			protocol = Math.min(protocol, info.protocol.current);
		}
		const externalSignal = this.externalSignal;
		if (externalSignal?.aborted) throw createAbortError('Sync request aborted');

		const headersWithoutContentType = Object.fromEntries(
			Object.entries(options.headers ?? {}).filter(([key]) => key.toLowerCase() !== 'content-type'),
		);
		const resolvedContentType = options.contentType
			?? getHeader(options.headers ?? {}, 'Content-Type')
			?? undefined;
		const operationId = crypto.randomUUID();
		const uploadOperationIds = normalizeUploadOperationIds((getHeader(options.headers ?? {}, 'X-Crate-Upload-Operation')
			?? getHeader(options.headers ?? {}, 'X-Crate-Upload-Operations') ?? '').split(','));
		const record = (outcome: RequestDiagnostic['outcome'], response?: ApiHttpResponse) => {
			this.requestDiagnostics.push({ at: new Date().toISOString(), operationId, method: options.method ?? 'GET',
				...(uploadOperationIds.length ? { uploadOperationIds } : {}), route: diagnosticRoute(path), status: response?.status ?? 0, outcome,
				requestId: response ? getHeader(response.headers, 'X-Crate-Request-Id') ?? undefined : undefined });
			if (this.requestDiagnostics.length > MAX_REQUEST_DIAGNOSTICS) this.requestDiagnostics.shift();
		};

		return await new Promise<ApiHttpResponse>((resolve, reject) => {
			let settled = false;
			let timeoutId: number | undefined;
			const cleanup = () => {
				if (timeoutId !== undefined) window.clearTimeout(timeoutId);
				externalSignal?.removeEventListener('abort', onAbort);
			};
			const resolveOnce = (response: ApiHttpResponse) => {
				if (settled) return;
				settled = true;
				cleanup();
				record('response', response);
				resolve(response);
			};
			const rejectOnce = (error: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				record(isAbortError(error) ? 'aborted' : 'failed');
				reject(error instanceof Error ? error : new Error(errorMessage(error)));
			};
			// The Obsidian transport cannot be cancelled. A rejected mutation may
			// still commit remotely; ignore its late response and reconcile on resume.
			const onAbort = () => rejectOnce(createAbortError('Sync request aborted'));

			externalSignal?.addEventListener('abort', onAbort, { once: true });
			timeoutId = window.setTimeout(
				() => rejectOnce(new Error(`Request timed out after ${timeout}ms`)),
				timeout,
			);
			void this.transport({
				url: `${this.workerUrl}${path}`,
				method: options.method,
				body: options.body,
				contentType: resolvedContentType,
				headers: {
					Authorization: `Bearer ${this.authToken}`,
					'X-Crate-Client-Session': this.clientSession,
					'X-Crate-Operation-Id': operationId,
					[CRATE_PROTOCOL_HEADER]: String(protocol),
					...headersWithoutContentType,
				},
			}).then(resolveOnce, error => {
				if (externalSignal?.aborted) {
					rejectOnce(createAbortError('Sync request aborted'));
					return;
				}
				rejectOnce(error);
			});
		});
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
			const details = parseErrorDetails(response.status, response.text);
			logger.error(`Request failed: ${options.method ?? 'GET'} ${path} -> ${details.message}`);
			throw new HttpError(
				details.message,
				response.status,
				parseRetryAfter(response.headers),
				details.code,
				details.currentHash,
				getHeader(response.headers, 'X-Crate-Request-Id') ?? undefined,
			);
		}

		logger.info(`${options.method ?? 'GET'} ${path.split('?')[0]} -> ${response.status} [request ${getHeader(response.headers, 'X-Crate-Request-Id') ?? 'unavailable'}]`);
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
			const details = parseErrorDetails(response.status, response.text);
			logger.error(`Request failed: ${options.method ?? 'GET'} ${path} -> ${details.message}`);
			throw new HttpError(
				details.message,
				response.status,
				parseRetryAfter(response.headers),
				details.code,
				details.currentHash,
				getHeader(response.headers, 'X-Crate-Request-Id') ?? undefined,
			);
		}

		logger.info(`${options.method ?? 'GET'} ${path.split('?')[0]} -> ${response.status} [request ${getHeader(response.headers, 'X-Crate-Request-Id') ?? 'unavailable'}] (binary)`);
		return { body: response.arrayBuffer, headers: response.headers };
	}
}

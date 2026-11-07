import { emptyRequestTimings } from '../diagnostics/timings';
import type { CrateServerInfo } from '../../protocol/server-info';
import { normalizeUploadOperationIds } from '../diagnostics/request-diagnostics';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER, isCompatibleCrateServer, isCrateMutation, parseCrateServerInfo } from '../../protocol/server-info';
import { UPLOAD_OPERATION_HEADER, UPLOAD_OPERATIONS_HEADER, CLIENT_SESSION_HEADER, OPERATION_ID_HEADER, REQUEST_ID_HEADER } from '../../protocol/http-headers';
import { requestUrl } from 'obsidian';
import { createLogger } from '../logger';
import { errorMessage } from '../../platform/logger';
import { createAbortError } from '../abort';
import { normalizeWorkerUrl } from '../connection/worker-url';
import { normalizeRequestDiagnostics, recordRequestDiagnostic, type RequestDiagnostic, type RequestDiagnostics } from '../diagnostics/request-diagnostics';
import { isAbortError } from '../abort';
import { ENCRYPTION_CAPABILITY, ENCRYPTION_GENERATION_HEADER, ENCRYPTION_STATE_HEADER, ENCRYPTION_VAULT_HEADER } from '../../encryption/server-state';
import { EncryptionDowngradeGuard } from './encryption-guard';

const logger = createLogger('ApiClient');

export const TRANSFER_TIMEOUT_MS = 120_000;
/** Default for ordinary requests, and the most a preflight check may wait. */
const REQUEST_TIMEOUT_MS = 30_000;
/** How long compatibility metadata is reused before it is read again. */
const SERVER_INFO_CACHE_MS = 30_000;
/** Slowest sustained link a body transfer still completes on, about 0.26 Mbit/s. */
const MIN_TRANSFER_BYTES_PER_SECOND = 32 * 1024;

/** A timed-out upload stays journaled and is replayed in full before every later
 * sync, so the limit grows with the body instead of capping it at a fast link. */
export function transferTimeout(bytes: number): number {
	return TRANSFER_TIMEOUT_MS + Math.floor(bytes * 1000 / MIN_TRANSFER_BYTES_PER_SECOND);
}

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

// Return Obsidian's response as is: copying `text` would decode every binary download as a string.
export const obsidianHttpTransport: ApiHttpTransport = request => requestUrl({
	url: request.url,
	method: request.method,
	body: request.body,
	contentType: request.contentType,
	headers: request.headers,
	throw: false,
});

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

/** The request did not reach the server or no response arrived in time. */
export class SyncTransportError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'SyncTransportError';
	}
}

/** Raises a failed response as an HttpError with its status, retry delay, code and request ID. */
function throwForErrorResponse(response: ApiHttpResponse, method: string, path: string): void {
	if (response.status < 400) return;
	const details = parseErrorDetails(response.status, response.text);
	logger.error(`Request failed: ${method} ${path} -> ${details.message}`);
	throw new HttpError(
		details.message,
		response.status,
		parseRetryAfter(response.headers),
		details.code,
		details.currentHash,
		getHeader(response.headers, REQUEST_ID_HEADER) ?? undefined,
	);
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

const encryptionDowngradeError = () => new HttpError('This vault was synced with end-to-end encryption, but this server reports none. Open Manage encryption to unlock it, or confirm syncing without encryption.', 428, null, 'encryption_downgrade');

export class WorkerApiHttpClient {
	private readonly clientSession = crypto.randomUUID();
	private requestDiagnostics: RequestDiagnostic[] = [];
	private workerUrl: string;
	private authToken: string;
	private encryptionHeaders: Record<string, string> = {};
	private externalSignal: AbortSignal | undefined;
	private requestTimings = emptyRequestTimings();
	private serverInfo?: { expires: number; value: CrateServerInfo };
	private serverInfoRequest?: Promise<CrateServerInfo>;
	private requestGeneration = 0;
	private readonly encryptionGuard = new EncryptionDowngradeGuard();

	constructor(
		workerUrl: string,
		authToken: string,
		private readonly transport: ApiHttpTransport = obsidianHttpTransport,
	) {
		this.workerUrl = normalizeWorkerUrl(workerUrl);
		this.authToken = authToken;
	}

	setEncryptionAuthority(vaultId: string, generation: number): void {
		this.encryptionHeaders = { [ENCRYPTION_VAULT_HEADER]: vaultId, [ENCRYPTION_GENERATION_HEADER]: String(generation) };
	}
	resetRequestTimings(): void { this.requestTimings = emptyRequestTimings(); }
	getRequestTimings() { return { ...this.requestTimings, ...(this.requestTimings.d1 ? { d1: { ...this.requestTimings.d1 } } : {}) }; }

	refusePlaintext(refused: boolean): void { this.encryptionGuard.refusePlaintext(refused); }
	refusesPlaintext(): boolean { return this.encryptionGuard.refusesPlaintext(); }
	observeEncryption(callback: (() => void) | undefined): void { this.encryptionGuard.observeEncryption(callback); }

	private invalidateRequests(): void {
		this.requestGeneration++;
		this.encryptionGuard.forget();
		this.serverInfo = undefined;
		this.serverInfoRequest = undefined;
	}

	private assertRequestCurrent(generation: number): void {
		if (this.externalSignal?.aborted) throw createAbortError('Sync request aborted');
		if (generation !== this.requestGeneration) throw createAbortError('Sync connection changed');
	}

	/** Bound metadata reuse; the Worker still fences every mutation by protocol. */
	async getServerInfo(timeout = REQUEST_TIMEOUT_MS): Promise<CrateServerInfo> {
		if (this.externalSignal?.aborted) throw createAbortError('Sync request aborted');
		if (this.serverInfo && this.serverInfo.expires > performance.now()) return this.serverInfo.value;
		if (this.serverInfoRequest) return this.serverInfoRequest;
		const pending = this.requestJson<unknown>('/.well-known/crate', {}, timeout).then(value => {
			if (this.serverInfoRequest !== pending) throw createAbortError('Server compatibility check was superseded');
			const info = parseCrateServerInfo(value);
			if (!info) throw new Error('Server returned invalid Crate compatibility metadata');
			if (this.serverInfoRequest === pending) this.serverInfo = { value: info, expires: performance.now() + SERVER_INFO_CACHE_MS };
			return info;
		}).finally(() => {
			if (this.serverInfoRequest === pending) this.serverInfoRequest = undefined;
		});
		this.serverInfoRequest = pending;
		return pending;
	}

	setAbortSignal(signal: AbortSignal): void {
		this.invalidateRequests();
		this.externalSignal = signal;
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

	/** Checks compatibility before a mutation, and that the server stores plaintext
	 * before a request would send or read it unencrypted. Resolves to the protocol to
	 * send, or is null when the request needs no check. */
	private preflight(path: string, options: ApiRequestOptions, timeout: number, generation: number): Promise<number> | null {
		const keyed = Boolean(this.encryptionHeaders[ENCRYPTION_VAULT_HEADER]);
		const mutation = isCrateMutation(path, options.method);
		if (!mutation && !this.encryptionGuard.readNeedsProbe(path, options.method, keyed)) return null;
		const checkTimeout = Math.min(timeout, REQUEST_TIMEOUT_MS);
		// Probe without a private body before dispatching plaintext.
		const probeEncryption = async (capable: boolean) => {
			if (!capable) throw encryptionDowngradeError();
			const state = await this.requestJson<{ encryption: unknown }>('/encryption', {}, checkTimeout);
			if (state.encryption !== null) throw new HttpError('Unlock this vault in Manage encryption before sending changes', 428, null, 'encryption_required');
			if (this.encryptionGuard.refusesPlaintext()) throw encryptionDowngradeError();
		};
		return (async () => {
			const info = await this.getServerInfo(checkTimeout);
			this.assertRequestCurrent(generation);
			if (!mutation) {
				await probeEncryption(info.capabilities.includes(ENCRYPTION_CAPABILITY));
				return CRATE_PLUGIN_PROTOCOL.current;
			}
			if (!info || !isCompatibleCrateServer(info)) throw new HttpError('Update the Crate server before making changes', 428, null, 'protocol_incompatible');
			const capable = info.capabilities.includes(ENCRYPTION_CAPABILITY);
			if (this.encryptionGuard.mutationNeedsProbe(path, capable, keyed)) await probeEncryption(capable);
			return Math.min(CRATE_PLUGIN_PROTOCOL.current, info.protocol.current);
		})();
	}

	private async runRequest(
		path: string,
		options: ApiRequestOptions,
		timeout: number,
	): Promise<ApiHttpResponse> {
		// Bind compatibility, dispatch and completion to the same connection.
		const generation = this.requestGeneration;
		const { workerUrl, authToken, externalSignal } = this;
		this.assertRequestCurrent(generation);
		const checks = this.preflight(path, options, timeout, generation);
		// Without checks, the request dispatches before this call returns.
		const protocol = checks ? await checks : CRATE_PLUGIN_PROTOCOL.current;

		const headersWithoutContentType = Object.fromEntries(
			Object.entries(options.headers ?? {}).filter(([key]) => key.toLowerCase() !== 'content-type'),
		);
		const resolvedContentType = options.contentType
			?? getHeader(options.headers ?? {}, 'Content-Type')
			?? undefined;
		const operationId = crypto.randomUUID();
		const started = performance.now();
		const dispatched = this.encryptionGuard.dispatched(started);
		const timings = this.requestTimings;
		const uploadOperationIds = normalizeUploadOperationIds((getHeader(options.headers ?? {}, UPLOAD_OPERATION_HEADER)
			?? getHeader(options.headers ?? {}, UPLOAD_OPERATIONS_HEADER) ?? '').split(','));
		const diagnosed = { operationId, method: options.method ?? 'GET', path, uploadOperationIds, started };
		const record = (outcome: RequestDiagnostic['outcome'], response?: ApiHttpResponse) => recordRequestDiagnostic(
			{ timings, requests: this.requestDiagnostics }, diagnosed, outcome,
			response && { status: response.status, header: name => getHeader(response.headers, name) });

		return await new Promise<ApiHttpResponse>((resolve, reject) => {
			let settled = false;
			let timeoutId: number | undefined;
			const cleanup = () => {
				if (timeoutId !== undefined) window.clearTimeout(timeoutId);
				externalSignal?.removeEventListener('abort', onAbort);
			};
			const resolveOnce = (response: ApiHttpResponse) => {
				if (settled) return;
				try { this.assertRequestCurrent(generation); }
				catch (error) { rejectOnce(error); return; }
				settled = true;
				cleanup();
				record('response', response);
				this.encryptionGuard.observe(getHeader(response.headers, ENCRYPTION_STATE_HEADER), response.status, dispatched);
				resolve(response);
			};
			const rejectOnce = (error: unknown) => {
				if (settled) return;
				try { this.assertRequestCurrent(generation); }
				catch (stale) { error = stale; }
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
				() => rejectOnce(new SyncTransportError(`Request timed out after ${timeout}ms`)),
				timeout,
			);
			void this.transport({
				url: `${workerUrl}${path}`,
				method: options.method,
				body: options.body,
				contentType: resolvedContentType,
				headers: {
					Authorization: `Bearer ${authToken}`,
					[CLIENT_SESSION_HEADER]: this.clientSession,
					[OPERATION_ID_HEADER]: operationId,
					[CRATE_PROTOCOL_HEADER]: String(protocol),
					...this.encryptionHeaders,
					...headersWithoutContentType,
				},
			}).then(resolveOnce, error => {
				if (externalSignal?.aborted) {
					rejectOnce(createAbortError('Sync request aborted'));
					return;
				}
				rejectOnce(isAbortError(error) ? error : new SyncTransportError(errorMessage(error), { cause: error }));
			});
		});
	}

	async requestJson<T>(
		path: string,
		options: ApiRequestOptions = {},
		timeout: number = REQUEST_TIMEOUT_MS,
	): Promise<T> {
		const response = await this.requestChecked(path, {
			...options,
			contentType: options.contentType ?? getHeader(options.headers ?? {}, 'Content-Type') ?? 'application/json',
		}, timeout);
		return parseJsonResponse<T>(response.text, path);
	}

	async requestBinary(
		path: string,
		options: ApiRequestOptions = {},
		timeout: number = REQUEST_TIMEOUT_MS,
	): Promise<{ body: ArrayBuffer; headers: Record<string, string> }> {
		const response = await this.requestChecked(path, options, timeout, ' (binary)');
		return { body: response.arrayBuffer, headers: response.headers };
	}

	/** Sends a request on the current connection and raises an error response. */
	private async requestChecked(path: string, options: ApiRequestOptions, timeout: number, logSuffix = ''): Promise<ApiHttpResponse> {
		const generation = this.requestGeneration;
		const method = options.method ?? 'GET';
		logger.info(`${method} ${path}${logSuffix}`);
		const response = await this.runRequest(path, options, timeout);
		this.assertRequestCurrent(generation);
		throwForErrorResponse(response, method, path);

		logger.info(`${method} ${path.split('?')[0]} -> ${response.status} [request ${getHeader(response.headers, REQUEST_ID_HEADER) ?? 'unavailable'}]${logSuffix}`);
		return response;
	}
}

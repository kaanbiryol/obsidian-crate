import { BULK_NEW_UPLOAD_MAX_FILES } from '../../protocol/sync-limits';
export const MAX_REQUEST_DIAGNOSTICS = 50;
import { isDiagnosticTimestamp, isUploadSession as opaqueId, normalizeUploadDiagnostics, type UploadDiagnostic } from './upload-diagnostics';
import { reminderOperationDay } from '../../protocol/reminder-operation';
import { D1_USAGE_HEADER, parseD1Usage } from '../../protocol/d1-usage';
import { REQUEST_ID_HEADER } from '../../protocol/http-headers';
import type { RequestTimings } from './timings';
const routes = new Set([
	'/sync/import', '/sync/import/upload', '/sync/import/prune', '/sync/import/complete', '/.well-known/crate', '/health', '/settings', '/diagnostics',
	...['manifest', 'metadata', 'upload', 'download', 'delete', 'changes', 'check', 'batch-upload', 'batch-download', 'batch-delete', 'versions', 'version-preview', 'restore-version'].map(route => `/sync/${route}`),
	'/auth/tokens',
	'/reminders/notification-policy', '/notifications/subscribe', '/notifications/subscriptions', '/notifications/test',
]);
const methods = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']);

export interface RequestDiagnostic {
	at: string;
	operationId: string;
	requestId?: string;
	method: string;
	route: string;
	status: number;
	outcome: 'response' | 'failed' | 'aborted';
	uploadOperationIds?: string[];
}
export interface RequestDiagnostics { clientSession: string; requests: RequestDiagnostic[]; uploads?: UploadDiagnostic[] }

/** A finished request as the diagnostics log sees it. */
interface DiagnosedRequest {
	operationId: string;
	method: string;
	path: string;
	uploadOperationIds: string[];
	started: number;
}

/** Records a finished request's outcome, timing and reported D1 usage, keeping the
 * latest MAX_REQUEST_DIAGNOSTICS. Reads only the named response headers. */
export function recordRequestDiagnostic(
	log: { timings: RequestTimings; requests: RequestDiagnostic[] },
	request: DiagnosedRequest,
	outcome: RequestDiagnostic['outcome'],
	response?: { status: number; header: (name: string) => string | null },
): void {
	const { timings } = log;
	const durationMs = Math.max(0, performance.now() - request.started);
	const match = response?.header('Server-Timing')?.match(/(?:^|,)\s*crate;dur=([0-9.]+)/);
	const serverMs = match ? Number(match[1]) : NaN;
	timings.count++; timings.totalMs += durationMs; timings.maxMs = Math.max(timings.maxMs, durationMs);
	if (Number.isFinite(serverMs) && serverMs >= 0) { timings.serverCount++; timings.serverMs += serverMs; }

	const usage = response ? parseD1Usage(response.header(D1_USAGE_HEADER)) : undefined;
	if (usage) {
		const d1 = timings.d1 ??= { rowsRead: 0, rowsWritten: 0, reportedRequests: 0, completeRequests: 0 };
		d1.rowsRead += usage.rowsRead; d1.rowsWritten += usage.rowsWritten;
		d1.reportedRequests++; if (usage.complete) d1.completeRequests++;
	}

	log.requests.push({ at: new Date().toISOString(), operationId: request.operationId, method: request.method,
		...(request.uploadOperationIds.length ? { uploadOperationIds: request.uploadOperationIds } : {}), route: diagnosticRoute(request.path),
		status: response?.status ?? 0, outcome, requestId: response?.header(REQUEST_ID_HEADER) ?? undefined });
	if (log.requests.length > MAX_REQUEST_DIAGNOSTICS) log.requests.shift();
}

export function normalizeUploadOperationIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((id): id is string => typeof id === 'string' && reminderOperationDay(id) !== null))].slice(0, BULK_NEW_UPLOAD_MAX_FILES);
}

function diagnosticRoute(path: string): string {
	const route = path.split('?')[0] ?? '';
	return routes.has(route) ? route : 'other';
}

/** Whitelist persisted/exported data; never copy arbitrary headers or errors. */
export function normalizeRequestDiagnostics(value: unknown): RequestDiagnostics | undefined {
	if (!value || typeof value !== 'object' || !('clientSession' in value) || !opaqueId(value.clientSession)
		|| !('requests' in value) || !Array.isArray(value.requests)) return undefined;
	const requests: RequestDiagnostic[] = [];
	for (const raw of value.requests.slice(-MAX_REQUEST_DIAGNOSTICS)) {
		if (!raw || typeof raw !== 'object') continue;
		const item = raw as Record<string, unknown>;
		if (!isDiagnosticTimestamp(item.at)
			|| !opaqueId(item.operationId) || typeof item.method !== 'string' || !methods.has(item.method)
			|| !['response', 'failed', 'aborted'].includes(String(item.outcome))) continue;
		requests.push({ at: item.at, operationId: item.operationId, method: item.method,
			route: typeof item.route === 'string' ? diagnosticRoute(item.route) : 'other',
			status: typeof item.status === 'number' && Number.isInteger(item.status) && item.status >= 100 && item.status <= 599 ? item.status : 0,
			outcome: item.outcome as RequestDiagnostic['outcome'],
			...(opaqueId(item.requestId) ? { requestId: item.requestId } : {}),
			...(normalizeUploadOperationIds(item.uploadOperationIds).length ? { uploadOperationIds: normalizeUploadOperationIds(item.uploadOperationIds) } : {}),
		});
	}
	return { clientSession: value.clientSession, requests,
		...('uploads' in value ? { uploads: normalizeUploadDiagnostics(value.uploads) } : {}) };
}

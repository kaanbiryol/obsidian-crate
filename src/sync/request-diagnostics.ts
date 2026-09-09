export const MAX_REQUEST_DIAGNOSTICS = 50;
import { normalizeUploadDiagnostics, type UploadDiagnostic } from './upload-diagnostics';
import { reminderOperationDay } from '../protocol/reminder-operation';
const routes = new Set([
	'/.well-known/crate', '/health', '/settings', '/diagnostics',
	...['manifest', 'metadata', 'upload', 'download', 'delete', 'changes', 'check', 'batch-upload', 'batch-download', 'batch-delete', 'versions', 'restore', 'restore-version'].map(route => `/sync/${route}`),
	...['tokens', 'revoke', 'enroll', 'enrollment'].map(route => `/auth/${route}`),
	'/reminders/notification-policy', '/notifications/subscribe', '/notifications/unsubscribe', '/notifications/subscriptions', '/notifications/test',
]);
const methods = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']);
const opaqueId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

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

export function normalizeUploadOperationIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((id): id is string => typeof id === 'string' && reminderOperationDay(id) !== null))].slice(0, 3);
}

export function diagnosticRoute(path: string): string {
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
		if (typeof item.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.at) || !Number.isFinite(Date.parse(item.at))
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

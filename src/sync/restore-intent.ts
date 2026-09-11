import { isRecord } from '../plugin/settings';
import { reminderOperationDay } from '../protocol/reminder-operation';
import { isSyncHash, isSyncRevision } from '../protocol/sync-validation';
import type { RemoteFileVersion, RestoreFileRequest } from '../protocol/sync-types';
import { parseFileVersions } from './worker-api/version-contract';

export interface RestoreIntent {
	request: RestoreFileRequest;
	version: RemoteFileVersion;
	phase: 'pending' | 'committed';
}

export function parseRestoreIntents(value: unknown): RestoreIntent[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error('Invalid saved restores. Preserve the sync checkpoint before recovery.');
	const ids = new Set<string>();
	const keys = new Set<string>();
	return value.map((entry: unknown) => {
		if (!isRecord(entry) || !isRecord(entry.request) || (entry.phase !== 'pending' && entry.phase !== 'committed')) throw new Error('Invalid saved restore');
		const request = entry.request;
		const version = parseFileVersions({ versions: [entry.version], hasMore: false }).versions[0]!;
		if (typeof request.operationId !== 'string' || reminderOperationDay(request.operationId) === null
			|| request.path !== version.path || request.storageKey !== version.storage_key
			|| (request.expectedHash !== null && !isSyncHash(request.expectedHash))
			|| (request.expectedHash === null ? request.expectedRevision !== null : !isSyncRevision(request.expectedRevision))
			|| ids.has(request.operationId) || keys.has(version.storage_key)) throw new Error('Invalid saved restore precondition');
		ids.add(request.operationId); keys.add(version.storage_key);
		return { version, phase: entry.phase, request: {
			operationId: request.operationId, path: version.path, storageKey: version.storage_key,
			expectedHash: request.expectedHash, expectedRevision: request.expectedRevision as string | null,
		} };
	});
}

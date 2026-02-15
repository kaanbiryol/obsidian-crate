import type { SyncResult, SyncStatus } from '../types';
import { createNotConfiguredSyncResult, createSyncInProgressResult } from './sync-result';

export function guardSyncConfigured(isConfigured: boolean): SyncResult | null {
	if (isConfigured) {
		return null;
	}
	return createNotConfiguredSyncResult();
}

export function guardSyncIdle(status: SyncStatus): SyncResult | null {
	if (status !== 'syncing') {
		return null;
	}
	return createSyncInProgressResult();
}

export function guardSyncStart(options: { isConfigured: boolean; status: SyncStatus }): SyncResult | null {
	return guardSyncConfigured(options.isConfigured) ?? guardSyncIdle(options.status);
}

export function acquireSyncLock(
	options: { isConfigured: boolean; status: SyncStatus },
	setStatus: () => void,
): SyncResult | null {
	const guard = guardSyncStart(options);
	if (guard) return guard;
	setStatus();
	return null;
}

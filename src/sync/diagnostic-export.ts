import { CRATE_PLUGIN_PROTOCOL } from '../protocol';
import { MAX_SYNC_HISTORY, type CrateSettings } from '../plugin/settings-types';
import type { SyncState } from './types';
import { normalizeRequestDiagnostics, type RequestDiagnostics } from './request-diagnostics';

const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
function timestamp(value: unknown): string | null {
	return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}

/** Explicitly select safe fields; raw settings, filenames and errors stay local. */
export function buildDiagnosticExport(settings: CrateSettings, state: SyncState, version: string, requests?: RequestDiagnostics): string {
	return JSON.stringify({
		format: 'crate-sync-diagnostics', version: 1, exportedAt: new Date().toISOString(),
		pluginVersion: /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) ? version : 'unknown',
		protocol: CRATE_PLUGIN_PROTOCOL.current,
		configured: Boolean(settings.workerUrl),
		status: ['idle', 'syncing', 'offline', 'error'].includes(state.status) ? state.status : 'unknown',
		lastSync: timestamp(state.lastSync), lastSeq: count(settings.lastSeq),
		pendingChanges: count(state.pendingChanges), conflicts: count(state.conflictCount), hasError: Boolean(state.lastError),
		requests: normalizeRequestDiagnostics(requests),
		history: settings.syncHistory.slice(0, MAX_SYNC_HISTORY).map(entry => ({
			at: timestamp(entry.timestamp), type: ['sync', 'initial', 'force'].includes(entry.type) ? entry.type : 'unknown',
			success: entry.success === true, uploaded: count(entry.uploaded), downloaded: count(entry.downloaded),
			merged: count(entry.merged), deleted: count(entry.deleted), errors: count(entry.errorCount),
			conflicts: count(entry.conflictCount), resolvedRaces: count(entry.resolvedRaceCount),
			requests: normalizeRequestDiagnostics(entry.requestDiagnostics),
		})),
	}, null, 2);
}

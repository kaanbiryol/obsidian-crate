import type CratePlugin from '../plugin/CratePlugin';
import type { ReminderMoveJournal } from './data/reminder-move-journal';

type SyncRuntimeView = Pick<CratePlugin['syncRuntime'], 'getState' | 'getApiClient' | 'isConfigured'>;
type ApiClient = ReturnType<SyncRuntimeView['getApiClient']>;

export interface ReminderScanGateHost {
	workspace: { readonly layoutReady: boolean };
	syncRuntime: SyncRuntimeView;
	journal: Pick<ReminderMoveJournal, 'hasPending' | 'isPendingFile'>;
}

export interface ReminderScanGate {
	/** Scans wait for the vault file list, an active sync and unresolved moves of the path. */
	shouldDeferScan: (filePath?: string) => boolean;
	/** Duplicate-ID repair waits until the current connection completes a sync. */
	shouldDeferCollisionRepair: () => boolean;
	/** Records the sync status; call it from the sync state listener. */
	onSyncStateChanged: () => void;
}

/** Connections that finished a sync while a reminder backend observed them. */
const verifiedApis = new WeakSet<NonNullable<ApiClient>>();

/**
 * Collision repair rewrites reminder IDs, so it waits until sync has reconciled
 * file ownership. A connection counts as verified only after it moves from
 * syncing to idle; a replaced connection needs its own successful sync.
 * Verification outlives the gate because a folder change or re-enable rebuilds
 * it, but an existing connection is not trusted: it may not have synced yet.
 */
export function createReminderScanGate({ workspace, syncRuntime, journal }: ReminderScanGateHost): ReminderScanGate {
	// A sync already running at a rebuild still reconciles the whole vault.
	let syncingApi: ApiClient = syncRuntime.getState().status === 'syncing' ? syncRuntime.getApiClient() : null;
	return {
		shouldDeferScan: path => !workspace.layoutReady || syncRuntime.getState().status === 'syncing' || Boolean(path && journal.isPendingFile(path)),
		shouldDeferCollisionRepair: () => {
			const api = syncRuntime.getApiClient();
			return journal.hasPending() || syncRuntime.isConfigured() && (!api || !verifiedApis.has(api))
				|| ['error', 'offline'].includes(syncRuntime.getState().status);
		},
		onSyncStateChanged: () => {
			const { status } = syncRuntime.getState();
			const api = syncRuntime.getApiClient();
			if (status === 'syncing') syncingApi = api;
			else {
				if (status === 'idle' && api && syncingApi === api) verifiedApis.add(api);
				syncingApi = null;
			}
		},
	};
}

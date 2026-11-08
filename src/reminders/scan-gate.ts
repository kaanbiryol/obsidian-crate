import type CratePlugin from '../plugin/CratePlugin';
import type { ReminderMoveJournal } from './data/reminder-move-journal';

type SyncRuntimeView = Pick<CratePlugin['syncRuntime'], 'getState' | 'getApiClient' | 'isConfigured' | 'isWritingVault'>;
type ApiClient = ReturnType<SyncRuntimeView['getApiClient']>;

export interface ReminderScanGateHost {
	workspace: { readonly layoutReady: boolean };
	syncRuntime: SyncRuntimeView;
	journal: Pick<ReminderMoveJournal, 'hasPending' | 'isPendingFile'>;
}

export interface ReminderScanGate {
	/** Reads wait for the vault file list and unresolved moves of the path, never for sync. */
	shouldDeferScan: (filePath?: string) => boolean;
	/** Writes (IDs, typed dates, duplicate repair) also wait while sync may change vault files. */
	shouldDeferWrites: (filePath?: string) => boolean;
	/** Duplicate-ID repair waits until the current connection completes a sync. */
	shouldDeferCollisionRepair: () => boolean;
	/** Records the sync status; call it from the sync state listener. */
	onSyncStateChanged: () => void;
}

/** Connections that finished a sync while a reminder backend observed them. */
const verifiedApis = new WeakSet<NonNullable<ApiClient>>();

/**
 * The index is derived from Markdown, so reads never wait for sync; vault events
 * correct anything sync changes afterwards. Writes would race downloads and merges,
 * so they wait while sync may change vault files; upload-only work does not block them.
 *
 * Collision repair rewrites reminder IDs, so it waits until sync has reconciled
 * file ownership. A connection counts as verified only after a sync that may change
 * vault files moves from syncing to idle. An upload-only flush does not count: after
 * a failed sync it would leave partly applied downloads unreconciled. A replaced
 * connection needs its own successful sync. Verification outlives the gate because
 * a folder change or re-enable rebuilds it, but an existing connection is not
 * trusted: it may not have synced yet.
 */
export function createReminderScanGate({ workspace, syncRuntime, journal }: ReminderScanGateHost): ReminderScanGate {
	// A sync already running at a rebuild still reconciles the whole vault.
	let syncingApi: ApiClient = syncRuntime.isWritingVault() ? syncRuntime.getApiClient() : null;
	const shouldDeferScan = (path?: string) => !workspace.layoutReady || Boolean(path && journal.isPendingFile(path));
	return {
		shouldDeferScan,
		shouldDeferWrites: path => shouldDeferScan(path) || syncRuntime.isWritingVault(),
		shouldDeferCollisionRepair: () => {
			const api = syncRuntime.getApiClient();
			return journal.hasPending() || syncRuntime.isConfigured() && (!api || !verifiedApis.has(api))
				|| ['error', 'offline'].includes(syncRuntime.getState().status);
		},
		onSyncStateChanged: () => {
			const { status } = syncRuntime.getState();
			const api = syncRuntime.getApiClient();
			// A first upload turns upload-only partway through; it keeps the sync it began as.
			if (status === 'syncing') { if (syncRuntime.isWritingVault()) syncingApi = api; }
			else {
				if (status === 'idle' && api && syncingApi === api) verifiedApis.add(api);
				syncingApi = null;
			}
		},
	};
}

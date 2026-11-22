import { Notice } from 'obsidian';
import type { SyncRuntime } from '../sync/runtime/runtime';
import type { SyncResult } from '../sync/types';
import { AUTH_ERROR_MESSAGE } from '../sync/sync-outcome';
import { isCrateUpdatePath } from './crate-update/bundle';

type NoticeRuntime = Pick<SyncRuntime, 'getState' | 'addSyncResultListener' | 'removeSyncResultListener'>;

interface NoticeHost {
	configDir: string;
	isMobile: boolean;
	register(cleanup: () => void): void;
	showSyncError(message: string): void;
	/** A persistent notice with a link to review the conflicts. */
	showConflicts(message: string): void;
}

export const RESTART_NOTICE = 'Obsidian settings changed on another device. Restart Obsidian to apply them.';

/** Summarizes the conflicts one sync created. */
function conflictMessage(conflictPaths: string[]): string {
	return conflictPaths.length === 1
		? `Sync conflict: ${conflictPaths[0]}\nReview the affected file; a local version may have been saved as a conflict copy.`
		: `${conflictPaths.length} sync conflicts detected.\nReview the affected files and any conflict copies.`;
}

/**
 * Sync results the person may not see. Every published result, manual or
 * automatic, reports the conflicts it created. Mobile has no status bar, so a failed
 * background sync gets one notice until a sync succeeds again. Obsidian reads
 * most configuration only at launch, so changed settings ask for one restart.
 */
export function registerSyncResultNotices(host: NoticeHost, runtime: NoticeRuntime): void {
	let failing = false, restartShown = false;
	const configPrefix = `${host.configDir}/`;
	const listener = (result: SyncResult) => {
		if (result.conflicts.length) host.showConflicts(conflictMessage(result.conflicts));
		// A Crate update shows its own notice once it is installed.
		const changedConfig = [...result.downloadedPaths, ...result.mergedPaths]
			.some(path => path.startsWith(configPrefix) && !isCrateUpdatePath(path, host.configDir));
		if (changedConfig && !restartShown) {
			restartShown = true;
			new Notice(RESTART_NOTICE, 15_000);
		}
		if (result.success) { failing = false; return; }
		const state = runtime.getState();
		// Offline and revoked-access states already show their own notice.
		if (failing || !host.isMobile || state.status === 'offline' || state.lastError === AUTH_ERROR_MESSAGE) return;
		failing = true;
		host.showSyncError('Crate sync failed.');
	};
	runtime.addSyncResultListener(listener);
	host.register(() => runtime.removeSyncResultListener(listener));
}

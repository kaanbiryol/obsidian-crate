import { Notice } from 'obsidian';
import type { SyncRuntime } from '../sync/runtime/runtime';
import type { SyncResult } from '../sync/types';
import { AUTH_ERROR_MESSAGE } from '../sync/sync-outcome';

type NoticeRuntime = Pick<SyncRuntime, 'getState' | 'addSyncResultListener' | 'removeSyncResultListener'>;

interface NoticeHost {
	configDir: string;
	isMobile: boolean;
	register(cleanup: () => void): void;
	showSyncError(message: string): void;
}

export const RESTART_NOTICE = 'Obsidian settings changed on another device. Restart Obsidian to apply them.';

/**
 * Sync results the person may not see: mobile has no status bar, so a failed
 * background sync gets one notice until a sync succeeds again. Obsidian reads
 * most configuration only at launch, so changed settings ask for one restart.
 */
export function registerSyncResultNotices(host: NoticeHost, runtime: NoticeRuntime): void {
	let failing = false, restartShown = false;
	const configPrefix = `${host.configDir}/`;
	const listener = (result: SyncResult) => {
		const changedConfig = [...result.downloadedPaths, ...result.mergedPaths].some(path => path.startsWith(configPrefix));
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

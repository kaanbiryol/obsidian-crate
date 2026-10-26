import type { DataAdapter } from 'obsidian';
import { isHiddenPath } from '../local/file-discovery';
import { assertLocalSyncPath } from '../local/local-path-safety';
import { pendingChangeKey } from '../pending/pending-change';
import type { LocalManifest } from '../manifest/manifest';
import type { SyncQueueController } from '../queue/controller';
import { createLogger } from '../logger';
import { errorMessage } from '../../platform/logger';

const logger = createLogger('SyncEngine');

interface RawConfigEventHost {
	vault: { readonly configDir: string; readonly adapter: Pick<DataAdapter, 'stat'> };
	manifest: Pick<LocalManifest, 'hasFile'>;
	queue: Pick<SyncQueueController, 'onFileChange' | 'onFileDelete' | 'hasPendingKey'>;
	isDestroyed: () => boolean;
	isSyncing: () => boolean;
	shouldIgnore: (path: string) => boolean;
	/** Returns a check that stays true until the next sync activity starts. */
	captureSyncActivity: () => () => boolean;
	/** Returns the keys whose files still match the manifest while `isCurrent` holds. */
	verifyPendingPaths: (keys: string[], isCurrent: (key: string) => boolean) => Promise<string[]>;
	trackWork: <T>(operation: () => Promise<T>) => Promise<T>;
}

/**
 * Hidden and configuration files reach sync only through raw vault events. The
 * handler queues each as a change or deletion; a newer event for a path
 * supersedes one still being inspected.
 */
export function createRawConfigEventHandler(host: RawConfigEventHost): (path: string) => Promise<void> {
	const revisions = new Map<string, object>();
	let verificationTask: Promise<unknown> = Promise.resolve();
	return async path => {
		if (!isHiddenPath(path) && !path.startsWith(`${host.vault.configDir}/`)) return;
		if (host.isDestroyed() || host.shouldIgnore(path)) return;
		const revision = {};
		revisions.set(path, revision);
		const isCurrent = () => !host.isDestroyed() && revisions.get(path) === revision && !host.shouldIgnore(path);
		try {
			assertLocalSyncPath(path);
			const stat = await host.vault.adapter.stat(path);
			if (!isCurrent()) return;
			if (stat?.type === 'file' && host.manifest.hasFile(path)
				&& !host.isSyncing() && !host.queue.hasPendingKey(pendingChangeKey('upload', path))) {
				// Obsidian and iCloud can touch settings without changing their bytes.
				// Check before publishing a pending entry; serialize reads to bound memory.
				const activityCurrent = host.captureSyncActivity();
				const verification = verificationTask.then(() => host.verifyPendingPaths([path],
					() => isCurrent() && !host.isSyncing() && activityCurrent()));
				verificationTask = verification.catch(() => {});
				const settled = await host.trackWork(() => verification).catch((error): string[] => {
					logger.warn('Could not verify changed configuration file:', errorMessage(error));
					return [];
				});
				if (!isCurrent() || settled.includes(path)) return;
			}
			if (stat?.type === 'file') host.queue.onFileChange({ path });
			else if (!stat) host.queue.onFileDelete({ path });
		} catch (error) {
			logger.warn('Failed to inspect changed configuration file:', errorMessage(error));
		} finally {
			if (revisions.get(path) === revision) revisions.delete(path);
		}
	};
}

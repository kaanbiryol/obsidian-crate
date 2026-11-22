import type { CheckResponse } from '../../protocol/sync-types';
import { createLogger } from '../logger';
import type { LocalManifest } from '../manifest/manifest';
import type { SyncSettings } from '../settings';

const logger = createLogger('ServerIdentity');

type BaselineState = { localManifest: Pick<LocalManifest, 'getAllPaths' | 'removeEntry' | 'save'>; setLastSeq(value: number): void };

/** Drops every baseline and the changelog cursor, so the next full sync merges with the
 * server as with a new one: local-only files upload, server-only files download, and a
 * file that differs on both sides keeps the local version as a conflict copy. Baselines
 * are saved cleared before the caller saves the cursor, so an interruption repeats this,
 * never a plan against the old baselines. */
export async function forgetServerBaselines(context: BaselineState): Promise<void> {
	for (const path of context.localManifest.getAllPaths()) context.localManifest.removeEntry(path);
	await context.localManifest.save();
	context.setLastSeq(0);
}

/** Runs before a standard sync plans anything. A server at this address with another
 * storage identity is a new or restored server, even when its changelog has reached this
 * device's cursor; planning against these baselines would move notes only this device has
 * to trash. A checkpoint without an identity adopts the server's. */
export async function reconcileServerIdentity(context: BaselineState & {
	settings: Pick<SyncSettings, 'lastSeq' | 'serverStorageId'>;
	checkForChanges(since: number): Promise<CheckResponse>;
	persistSettings(): Promise<void>;
}): Promise<void> {
	const { storageId } = await context.checkForChanges(context.settings.lastSeq);
	if (storageId === context.settings.serverStorageId) return;
	if (context.settings.serverStorageId !== undefined) {
		logger.warn('This address now serves another server; merging with it as with a new server');
		await forgetServerBaselines(context);
	}
	// Recorded only after the cleared baselines are saved.
	context.settings.serverStorageId = storageId;
	await context.persistSettings();
}

import { createPathRecord, getPathEntry } from '../../protocol/path-record';
import type { FileEntry } from '../../protocol/sync-types';
import type { InitialConfigPull } from '../manifest/initial-config-pull';
import type { FullSyncPlannerContext } from './types';

export async function prepareInitialConfigPull(
	context: FullSyncPlannerContext,
	localFiles: Record<string, FileEntry>,
	discoveredPaths: string[],
	remoteFiles: Record<string, FileEntry>,
): Promise<InitialConfigPull | undefined> {
	const policy = context.initialConfigPull;
	if (!policy?.firstSync) return undefined;
	const configDir = context.vault.configDir;
	let state = policy.get();
	if (state && state.configDir !== configDir) return undefined;
	if (!state) {
		if (!configDir || Object.keys(context.localManifest.getManifest().files).length
			|| discoveredPaths.some(path => !path.startsWith(`${configDir}/`))) return undefined;
		const files = createPathRecord<string>();
		for (const [path, local] of Object.entries(localFiles)) {
			const remote = getPathEntry(remoteFiles, path);
			if (remote && local.hash !== remote.hash) files[path] = local.hash;
		}
		if (!Object.keys(files).length) return undefined;
		state = { configDir, files };
	}
	// Save the original hashes before any downloads or baseline updates. A retry
	// may replace only those same setup bytes, even after a restart or partial pull.
	await policy.save(state);
	context.throwIfDestroyed?.();
	return state;
}

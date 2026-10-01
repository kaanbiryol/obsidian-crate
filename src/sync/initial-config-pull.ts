import { isRecord } from '../platform/validation';
import { createPathRecord, getPathEntry } from '../protocol/path-record';
import { isSyncHash, isSyncPath } from '../protocol/sync-validation';
import type { FileEntry } from '../protocol/sync-types';
import type { FullSyncPlannerContext } from './planner-types';

/** Local setup bytes that may be replaced during an empty vault's first pull. */
export interface InitialConfigPull {
	configDir: string;
	files: Record<string, string>;
}

export function parseInitialConfigPull(value: unknown): InitialConfigPull | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || !isSyncPath(value.configDir) || !isRecord(value.files)) {
		throw new Error('Invalid initial settings pull checkpoint');
	}
	const files = createPathRecord<string>();
	for (const [path, hash] of Object.entries(value.files)) {
		if (!isSyncPath(path) || !path.startsWith(`${value.configDir}/`) || !isSyncHash(hash)) {
			throw new Error('Invalid initial settings pull checkpoint');
		}
		files[path] = hash;
	}
	return { configDir: value.configDir, files };
}

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

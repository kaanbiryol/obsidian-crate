import { createPathRecord, getPathEntry } from '../../protocol/path-record';
import type { FileEntry } from '../../protocol/sync-types';
import type { InitialConfigPull } from '../manifest/initial-config-pull';
import type { FullSyncPlannerContext } from './types';

/** Obsidian writes this note into every new vault, including on mobile. */
const NEW_VAULT_NOTE = 'Welcome.md';
const NEW_VAULT_NOTE_MAX_BYTES = 4096;

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
			|| discoveredPaths.some(path => !path.startsWith(`${configDir}/`) && !isNewVaultNote(path, localFiles))) return undefined;
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

/** The note still syncs normally; it only does not make a new vault look used. */
function isNewVaultNote(path: string, localFiles: Record<string, FileEntry>): boolean {
	return path === NEW_VAULT_NOTE && (getPathEntry(localFiles, path)?.size ?? Infinity) <= NEW_VAULT_NOTE_MAX_BYTES;
}

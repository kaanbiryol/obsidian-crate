import { pendingChangeKey } from './pending-change';
import type { Vault } from 'obsidian';
import type { LocalManifestView } from '../manifest/manifest';
import { getPathEntry } from '../../protocol/path-record';
import { getAllVaultFiles, type VaultFile } from '../local/file-discovery';
import { sha256Hex } from '../../platform/sha256';
import { isOversizedSyncFile, hasLocalMetadataChange } from '../local/local-file-changes';
import { localPathExists } from '../local/stored-name';

/** Rebuild the volatile queue from local bytes without changing sync authority. */
export async function findStartupPendingPaths(context: {
	vault: Vault;
	baseline: LocalManifestView['files'];
	shouldIgnore(path: string): boolean;
	signal: AbortSignal;
	verifyContent(files: VaultFile[]): Promise<unknown>;
	runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]>;
	maxFileBytes: number;
}, concurrency: number): Promise<string[]> {
	const files = await getAllVaultFiles(context.vault, path => context.shouldIgnore(path), () => context.signal.throwIfAborted());
	// The rotating check marks same-metadata edits unverified, so the metadata
	// shortcut below re-reads them instead of hashing the whole vault on startup.
	await context.verifyContent(files);
	context.signal.throwIfAborted();
	const changes = await context.runConcurrent(files.map(file => async () => {
		context.signal.throwIfAborted();
		const entry = getPathEntry(context.baseline, file.path);
		if (isOversizedSyncFile(file, context.maxFileBytes)) return null;
		if (!entry) return pendingChangeKey('upload', file.path);
		if (!hasLocalMetadataChange(file, entry)) return null;
		const hash = await sha256Hex(await context.vault.adapter.readBinary(file.path));
		return hash === entry.hash ? null : pendingChangeKey('upload', file.path);
	}), concurrency);
	const present = new Set(files.map(file => file.path));
	const missing = Object.keys(context.baseline).filter(path => !context.shouldIgnore(path)
		&& !present.has(path));
	const deletions = await context.runConcurrent(missing.map(path => async () => {
		context.signal.throwIfAborted();
		return await localPathExists(context.vault, path) ? null : pendingChangeKey('delete', path);
	}), concurrency);
	context.signal.throwIfAborted();
	return [...changes, ...deletions].filter((path): path is string => path !== null);
}

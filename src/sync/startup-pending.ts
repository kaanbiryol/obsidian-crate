import { pendingChangeKey } from './pending-change';
import type { Vault } from 'obsidian';
import type { LocalManifestView } from './manifest';
import { getPathEntry } from '../protocol/path-record';
import { MAX_FILE_SIZE_BYTES } from '../protocol/sync-limits';
import { getAllVaultFiles, type VaultFile } from './file-discovery';
import { computeHash } from './hasher';

/** Rebuild the volatile queue from local bytes without changing sync authority. */
export async function findStartupPendingPaths(context: {
	vault: Vault;
	baseline: LocalManifestView['files'];
	shouldIgnore(path: string): boolean;
	throwIfDestroyed(): void;
	verifyContent(files: VaultFile[]): Promise<unknown>;
	runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]>;
}, concurrency: number): Promise<string[]> {
	const files = await getAllVaultFiles(context.vault, path => context.shouldIgnore(path), () => context.throwIfDestroyed());
	// The rotating check marks same-metadata edits unverified, so the metadata
	// shortcut below re-reads them instead of hashing the whole vault on startup.
	await context.verifyContent(files);
	context.throwIfDestroyed();
	const changes = await context.runConcurrent(files.map(file => async () => {
		context.throwIfDestroyed();
		const entry = getPathEntry(context.baseline, file.path);
		// Oversized files are skipped by sync, so they are never pending.
		if (file.size > MAX_FILE_SIZE_BYTES) return null;
		if (!entry) return pendingChangeKey('upload', file.path);
		if (entry.size === file.size && Date.parse(entry.modified) === file.mtime) return null;
		const hash = await computeHash(await context.vault.adapter.readBinary(file.path));
		return hash === entry.hash ? null : pendingChangeKey('upload', file.path);
	}), concurrency);
	const present = new Set(files.map(file => file.path));
	const missing = Object.keys(context.baseline).filter(path => !context.shouldIgnore(path)
		&& !present.has(path));
	const deletions = await context.runConcurrent(missing.map(path => async () => {
		context.throwIfDestroyed();
		return await context.vault.adapter.exists(path) ? null : pendingChangeKey('delete', path);
	}), concurrency);
	context.throwIfDestroyed();
	return [...changes, ...deletions].filter((path): path is string => path !== null);
}

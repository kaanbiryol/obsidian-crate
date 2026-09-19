import type { Vault } from 'obsidian';
import type { FileEntry } from '../protocol/sync-types';
import { getPathEntry } from '../protocol/path-record';
import { MAX_FILE_SIZE_BYTES } from '../protocol/sync-limits';
import { getAllVaultFiles } from './file-discovery';
import { computeHash } from './hasher';

/** Rebuild the volatile queue from local bytes without changing sync authority. */
export async function findStartupPendingPaths(context: {
	vault: Vault;
	baseline: Record<string, FileEntry>;
	shouldIgnore(path: string): boolean;
	throwIfDestroyed(): void;
	runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]>;
}, concurrency: number): Promise<string[]> {
	const files = await getAllVaultFiles(context.vault, path => context.shouldIgnore(path));
	const changes = await context.runConcurrent(files.map(file => async () => {
		context.throwIfDestroyed();
		const entry = getPathEntry(context.baseline, file.path);
		if (!entry || file.size > MAX_FILE_SIZE_BYTES) return file.path;
		const hash = await computeHash(await context.vault.adapter.readBinary(file.path));
		return hash === entry.hash ? null : file.path;
	}), concurrency);
	const present = new Set(files.map(file => file.path));
	const missing = Object.keys(context.baseline).filter(path => !context.shouldIgnore(path)
		&& !present.has(path));
	const deletions = await context.runConcurrent(missing.map(path => async () => {
		context.throwIfDestroyed();
		return await context.vault.adapter.exists(path) ? null : `delete:${path}`;
	}), concurrency);
	context.throwIfDestroyed();
	return [...changes, ...deletions].filter((path): path is string => path !== null);
}

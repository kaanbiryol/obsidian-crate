import { pendingChangeKey } from '../pending/pending-change';
import { withSyncFileContext } from '../issues';
import { forgetNestedHiddenFolders, getAllVaultFiles, isHiddenPath } from "../local/file-discovery";
import type { LocalChangeScan, LocalDiffPlannerContext } from "./types";
import { sha256Hex } from '../../platform/sha256';
import { partitionSkippedUploads, hasLocalMetadataChange } from '../local/local-file-changes';
import { localPathExists } from '../local/stored-name';

export async function getLocalDeletes(
	context: LocalDiffPlannerContext,
	discoveredPaths: ReadonlySet<string>,
	prepareConcurrency: number,
): Promise<string[]> {
	// Only paths discovery missed can be deletes, and each is confirmed absent before it
	// counts; a case or Unicode variant of its name, as after a case-only rename, does not
	// keep it. Discovery may skip a hidden folder it has not found yet, so a candidate that
	// exists makes the next scan walk every folder.
	const candidates = context.localManifest
		.getAllPaths()
		.filter((path) => !context.shouldIgnore(path) && !discoveredPaths.has(path));

	const tasks = candidates.map((path) => async () => {
		context.signal.throwIfAborted();
		const exists = await withSyncFileContext(path, () => localPathExists(context.vault, path));
		context.signal.throwIfAborted();
		if (exists && isHiddenPath(path)) forgetNestedHiddenFolders(context.vault);
		return exists ? null : path;
	});

	const results = await context.runConcurrent(tasks, prepareConcurrency);
	return results.filter((path): path is string => path !== null);
}

export async function getLocalChanges(
	context: LocalDiffPlannerContext,
	prepareConcurrency: number,
	onUnchanged?: (path: string) => void,
): Promise<LocalChangeScan> {
	const changes: Array<{ path: string; hash: string }> = [];
	const allFiles = await getAllVaultFiles(context.vault, context.shouldIgnore.bind(context), () => context.signal.throwIfAborted(), true);
	await context.verifyContent(allFiles);
	context.signal.throwIfAborted();

	// Skipped files stay discovered (never local deletes) but are not changes:
	// each would fail every sync and hold back the changelog cursor.
	const { eligible, skipped } = partitionSkippedUploads(allFiles, context.encrypted(), context.maxFileBytes());

	const candidates = eligible.filter(file => context.pendingKeys?.has(pendingChangeKey('upload', file.path))
		|| hasLocalMetadataChange(file, context.localManifest.getEntry(file.path)));

	const tasks = candidates.map((file) => async () => {
		context.signal.throwIfAborted();
		const content = await withSyncFileContext(file.path, () => context.vault.adapter.readBinary(file.path));
		context.signal.throwIfAborted();
		const hash = await sha256Hex(content);
		context.signal.throwIfAborted();
			context.plannedContent?.remember(file.path, content, hash);
		const existing = context.localManifest.getEntry(file.path);
		if (!existing || existing.hash !== hash) {
			return { path: file.path, hash };
		}
		context.localManifest.setEntry(file.path, {
			...existing,
			hash,
			size: file.size,
			modified: new Date(file.mtime).toISOString(),
		});
		onUnchanged?.(file.path);
		return null;
	});

	const results = await context.runConcurrent(tasks, prepareConcurrency);
	for (const result of results) {
		if (result) {
			changes.push(result);
		}
	}

	return { changes, discoveredPaths: new Set(allFiles.map((file) => file.path)), skipped };
}

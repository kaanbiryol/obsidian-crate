import type { Vault } from 'obsidian';
import { HttpError } from './api';
import { computeHash } from './hasher';
import { isHiddenPath } from './file-discovery';
import { classifyPath } from './reconciliation';
import { createEmptySyncResult, finalizeSyncResult } from './sync-result';
import { isVaultTFileLike } from './transfer-prepare';
import type { FileDiff, FileEntry, FileManifest, SyncResult } from '../plugin/types';
import { MAX_FILE_SIZE_BYTES } from '../plugin/types';
import { errorMessage } from '../plugin/logger';

const MAX_RECONCILE_ATTEMPTS = 3;

interface TargetedManifest {
	getEntry(path: string): FileEntry | undefined;
	setEntry(path: string, entry: FileEntry): void;
	removeEntry(path: string): void;
	save(): Promise<void>;
}

export interface TargetedReconcileContext {
	vault: Vault;
	localManifest: TargetedManifest;
	getRemoteManifest(): Promise<FileManifest>;
	shouldIgnore(path: string): boolean;
	getModifiedIso(path: string): Promise<string>;
	processDiff(
		diff: FileDiff,
		localFiles: Record<string, FileEntry>,
		result: SyncResult,
	): Promise<void>;
}

/** Reconcile only queue paths that lost a compare-and-swap race. */
export async function reconcileQueuePaths(
	context: TargetedReconcileContext,
	queueKeys: string[],
): Promise<SyncResult> {
	const result = createEmptySyncResult();
	let remoteManifest = await context.getRemoteManifest();

	for (const queueKey of [...new Set(queueKeys)]) {
		const path = queueKey.startsWith('delete:') ? queueKey.substring(7) : queueKey;
		if (context.shouldIgnore(path)) {
			result.settledPaths.push(queueKey);
			continue;
		}

		let settled = false;
		for (let attempt = 1; attempt <= MAX_RECONCILE_ATTEMPTS; attempt++) {
			try {
				const localEntry = await readLocalEntry(context, path);
				const remoteEntry = remoteManifest.files[path];
				const baseEntry = context.localManifest.getEntry(path);
				const decision = classifyPath(path, localEntry, remoteEntry, baseEntry);
				const localFiles = localEntry ? { [path]: localEntry } : {};

				if (decision) {
					const completedBefore = completedOperationCount(result);
					await context.processDiff(decision, localFiles, result);
					if (completedOperationCount(result) === completedBefore) {
						if (attempt < MAX_RECONCILE_ATTEMPTS) {
							remoteManifest = await context.getRemoteManifest();
							continue;
						}
						throw new Error('Path changed again before reconciliation completed');
					}
				} else if (localEntry && remoteEntry) {
					context.localManifest.setEntry(path, {
						...remoteEntry,
						modified: await context.getModifiedIso(path),
					});
				} else {
					context.localManifest.removeEntry(path);
				}

				result.settledPaths.push(queueKey);
				settled = true;
				break;
			} catch (error) {
				if (error instanceof HttpError && error.status === 409 && attempt < MAX_RECONCILE_ATTEMPTS) {
					remoteManifest = await context.getRemoteManifest();
					continue;
				}
				result.errors.push(`${path}: ${errorMessage(error)}`);
				break;
			}
		}

		if (!settled && !result.errors.some((error) => error.startsWith(`${path}:`))) {
			result.errors.push(`${path}: Reconciliation did not converge`);
		}
	}

	await context.localManifest.save();
	finalizeSyncResult(result);
	return result;
}

async function readLocalEntry(
	context: Pick<TargetedReconcileContext, 'vault' | 'getModifiedIso'>,
	path: string,
): Promise<FileEntry | undefined> {
	const abstractFile = context.vault.getAbstractFileByPath(path);
	const exists = isVaultTFileLike(abstractFile)
		|| (isHiddenPath(path) && await context.vault.adapter.exists(path));
	if (!exists) return undefined;

	const content = await context.vault.adapter.readBinary(path);
	if (content.byteLength > MAX_FILE_SIZE_BYTES) {
		throw new Error('Skipped local file larger than 25MB');
	}
	return {
		hash: await computeHash(content),
		size: content.byteLength,
		modified: await context.getModifiedIso(path),
	};
}

function completedOperationCount(result: SyncResult): number {
	return result.uploaded
		+ result.downloaded
		+ result.merged
		+ result.deleted
		+ result.unresolvedConflicts.length
		+ result.resolvedRaces.length;
}

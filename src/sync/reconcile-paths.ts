import type { Vault } from 'obsidian';
import { HttpError } from './api';
import { computeHash } from './hasher';
import { isHiddenPath } from './file-discovery';
import { classifyPath } from './reconciliation';
import { isQueueVersionConflict } from './queue-failure';
import { createEmptySyncResult, finalizeSyncResult } from './sync-result';
import { RemoteVersionChangedError } from './transfer-download';
import { isVaultTFileLike } from './transfer-prepare';
import type { FileDiff, FileEntry, SyncResult } from '../plugin/types';
import { MAX_FILE_SIZE_BYTES } from '../plugin/types';
import { errorMessage } from '../plugin/logger';
import type { DiffApplyOutcome } from './transfer-types';

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
	getRemoteEntries(paths: string[]): Promise<Record<string, FileEntry>>;
	shouldIgnore(path: string): boolean;
	getModifiedIso(path: string): Promise<string>;
	processDiff(
		diff: FileDiff,
		localFiles: Record<string, FileEntry>,
		result: SyncResult,
	): Promise<DiffApplyOutcome>;
}

/** Reconcile only queue paths that lost a compare-and-swap race. */
export async function reconcileQueuePaths(
	context: TargetedReconcileContext,
	queueKeys: string[],
): Promise<SyncResult> {
	const result = createEmptySyncResult();
	const uniqueQueueKeys = [...new Set(queueKeys)];
	const targetPaths = [...new Set(uniqueQueueKeys.map(queueKey =>
		queueKey.startsWith('delete:') ? queueKey.substring(7) : queueKey))];
	const remoteEntries = await context.getRemoteEntries(targetPaths);

	for (const queueKey of uniqueQueueKeys) {
		const path = queueKey.startsWith('delete:') ? queueKey.substring(7) : queueKey;
		if (context.shouldIgnore(path)) {
			result.settledPaths.push(queueKey);
			continue;
		}

		let settled = false;
		for (let attempt = 1; attempt <= MAX_RECONCILE_ATTEMPTS; attempt++) {
			try {
				const localEntry = await readLocalEntry(context, path);
				const remoteEntry = remoteEntries[path];
				const baseEntry = context.localManifest.getEntry(path);
				const decision = classifyPath(path, localEntry, remoteEntry, baseEntry);
				const localFiles = localEntry ? { [path]: localEntry } : {};

				if (decision) {
					const outcome = await context.processDiff(decision, localFiles, result);
					if (outcome.status === 'deferred') {
						if (attempt < MAX_RECONCILE_ATTEMPTS) {
							await refreshRemoteEntry(context, remoteEntries, path);
							continue;
						}
						throw new Error(outcome.reason);
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
				const remoteVersionChanged = error instanceof RemoteVersionChangedError
					|| (error instanceof HttpError && isQueueVersionConflict(error.status));
				if (remoteVersionChanged && attempt < MAX_RECONCILE_ATTEMPTS) {
					await refreshRemoteEntry(context, remoteEntries, path);
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

async function refreshRemoteEntry(
	context: Pick<TargetedReconcileContext, 'getRemoteEntries'>,
	remoteEntries: Record<string, FileEntry>,
	path: string,
): Promise<void> {
	const refreshed = await context.getRemoteEntries([path]);
	const entry = refreshed[path];
	if (entry) remoteEntries[path] = entry;
	else delete remoteEntries[path];
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

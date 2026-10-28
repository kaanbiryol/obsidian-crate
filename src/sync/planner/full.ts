import { oversizedRemoteFileIssue, withSyncFileContext } from '../issues';
import { skippedUploadIssue } from '../local/local-file-changes';
import { classifyPaths } from "./reconciliation";
import { getAllVaultFiles } from "../local/file-discovery";
import type { FullSyncPlan, FullSyncPlannerContext } from "./types";
import { MAX_FILE_SIZE_BYTES } from '../../protocol/sync-limits';
import type { FileEntry } from '../../protocol/sync-types';
import { createPathRecord, getPathEntry } from '../../protocol/path-record';
import { prepareInitialConfigPull } from './initial-config-pull';
import { sha256Hex } from '../../platform/sha256';

/** `reuseUnchangedHashes` trusts the baseline hash when size and mtime match,
 * as incremental sync does. Only automatic recovery from an expired or failed
 * incremental cursor uses it; first and manual full syncs read every file. */
export async function createFullSyncPlan(
	context: FullSyncPlannerContext,
	remoteFiles: Record<string, FileEntry>,
	prepareConcurrency: number,
	options: { reuseUnchangedHashes?: boolean } = {},
): Promise<FullSyncPlan> {
	const localFiles = createPathRecord<FileEntry>();
	const files = await getAllVaultFiles(context.vault, context.shouldIgnore.bind(context), () => context.throwIfDestroyed());
	const skipped = files.flatMap(file => skippedUploadIssue(file, context.encrypted?.() ?? false) ?? []);
	const skippedLocalPaths = new Set(skipped.map(issue => issue.path));
	const eligible = files.filter((file) => !skippedLocalPaths.has(file.path));

	const hashTasks = eligible
		.map((file) => () => withSyncFileContext(file.path, async () => {
			context.throwIfDestroyed();
			const baseline = options.reuseUnchangedHashes ? context.localManifest.getEntry(file.path) : undefined;
			if (baseline && baseline.size === file.size && new Date(baseline.modified).getTime() === file.mtime) {
				return { path: file.path, hash: baseline.hash, size: file.size, mtime: file.mtime };
			}
			const content = await context.vault.adapter.readBinary(file.path);
			context.throwIfDestroyed();
			const hash = await sha256Hex(content);
			context.throwIfDestroyed();
			context.plannedContent?.remember(file.path, content, hash);
			return { path: file.path, hash, size: content.byteLength, mtime: file.mtime };
		}));
	const hashed = await context.runConcurrent(hashTasks, prepareConcurrency);
	for (const entry of hashed) {
		localFiles[entry.path] = {
			hash: entry.hash,
			size: entry.size,
			modified: new Date(entry.mtime).toISOString(),
		};
	}

	const manifestEntries = context.localManifest.getManifest().files;
	const initialConfig = await prepareInitialConfigPull(context, localFiles, files.map(file => file.path), remoteFiles);
	const diffMap = new Map<string, import("../types").FileDiff>();
	for (const diff of classifyPaths(localFiles, remoteFiles, manifestEntries)) {
		const setupHash = initialConfig && getPathEntry(initialConfig.files, diff.path);
		diffMap.set(diff.path, diff.action === 'conflict' && diff.cause === 'concurrent-create' && setupHash === diff.localHash
			? { path: diff.path, action: 'download', localHash: diff.localHash, remoteHash: diff.remoteHash, cause: 'remote-created' }
			: diff);
	}

	for (const path of Object.keys(manifestEntries)) {
		if (!getPathEntry(localFiles, path) && !getPathEntry(remoteFiles, path)) {
			context.localManifest.removeEntry(path);
		}
	}

	for (const [path, local] of Object.entries(localFiles)) {
		const remoteEntry = getPathEntry(remoteFiles, path);
		if (local.hash === remoteEntry?.hash) context.localManifest.setEntry(path, { ...local, revision: remoteEntry.revision });
	}

	// Skipped files on either side are reported, not failures, so they never hold back the cursor.
	const issues = [...skipped];
	for (const [path, diff] of [...diffMap.entries()]) {
		const remoteEntry = getPathEntry(remoteFiles, path);
		if (context.shouldIgnore(path)) {
			diffMap.delete(path);
			continue;
		}
		if (skippedLocalPaths.has(path)) {
			diffMap.delete(path);
			continue;
		}
		if (remoteEntry && remoteEntry.size > MAX_FILE_SIZE_BYTES) {
			issues.push(oversizedRemoteFileIssue(path));
			diffMap.delete(path);
			// The local copy was never reconciled with the server, so it must not become the baseline.
			delete localFiles[path];
			continue;
		}
		if (diff.action === "download" && !remoteEntry) {
			diffMap.delete(path);
		}
	}

	const diffs = [...diffMap.values()];
	return {
		localFiles,
		diffs,
		uploadDiffs: diffs.filter((diff): diff is import("../types").UploadDiff => diff.action === "upload"),
		downloadDiffs: diffs.filter((diff): diff is import("../types").DownloadDiff => diff.action === "download"),
		remainingDiffs: diffs.filter((diff) =>
			diff.action === "conflict" || diff.action === "delete" || diff.action === "delete-local"
		),
		...(issues.length ? { issues } : {}),
	};
}

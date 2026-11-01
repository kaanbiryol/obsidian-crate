import { oversizedRemoteFileIssue, rejectedSealedNoteIssue, withSyncFileContext } from '../issues';
import { partitionSkippedUploads } from '../local/local-file-changes';
import { classifyPaths } from "./reconciliation";
import { getAllVaultFiles } from "../local/file-discovery";
import { createAbortError } from "../abort";
import type { FullSyncPlan, FullSyncPlannerContext } from "./types";
import { MAX_FILE_SIZE_BYTES } from '../../protocol/sync-limits';
import type { FileEntry } from '../../protocol/sync-types';
import { createPathRecord, getPathEntry } from '../../protocol/path-record';
import { prepareInitialConfigPull } from './initial-config-pull';
import { sha256Hex } from '../../platform/sha256';

/** `reuseUnchangedHashes` trusts the baseline hash when size and mtime match,
 * as incremental sync does. Only automatic recovery from an expired or failed
 * incremental cursor uses it; first and manual full syncs read every file.
 * Local hashes do not depend on the server, so a pending `remote` request overlaps
 * the local scan; if it fails, the scan stops and raises the request's error. */
export async function createFullSyncPlan(
	context: FullSyncPlannerContext,
	remote: Record<string, FileEntry> | Promise<Record<string, FileEntry>>,
	prepareConcurrency: number,
	options: { reuseUnchangedHashes?: boolean } = {},
): Promise<FullSyncPlan> {
	const remoteRequest = Promise.resolve(remote);
	let remoteFailure: { error: unknown } | undefined;
	void remoteRequest.catch((error: unknown) => { remoteFailure = { error }; });
	// An abort is not attributed to the file being read; `scan` raises the request's error instead.
	const throwIfStopped = () => {
		context.throwIfDestroyed();
		if (remoteFailure) throw createAbortError('Remote manifest request failed');
	};
	// A failed request takes precedence over a local failure, as when it finished first.
	const scan = async <T>(work: Promise<T>): Promise<T> => {
		try { return await work; }
		catch (error) {
			await remoteRequest.catch(() => {});
			throw remoteFailure ? remoteFailure.error : error;
		}
	};
	const localFiles = createPathRecord<FileEntry>();
	const files = await scan(getAllVaultFiles(context.vault, context.shouldIgnore.bind(context), throwIfStopped));
	const { eligible, skipped } = partitionSkippedUploads(files, context.encrypted());
	const skippedLocalPaths = new Set(skipped.map(issue => issue.path));

	const hashTasks = eligible
		.map((file) => () => withSyncFileContext(file.path, async () => {
			throwIfStopped();
			const baseline = options.reuseUnchangedHashes ? context.localManifest.getEntry(file.path) : undefined;
			if (baseline && baseline.size === file.size && new Date(baseline.modified).getTime() === file.mtime) {
				return { path: file.path, hash: baseline.hash, size: file.size, mtime: file.mtime };
			}
			const content = await context.vault.adapter.readBinary(file.path);
			throwIfStopped();
			const hash = await sha256Hex(content);
			throwIfStopped();
			context.plannedContent?.remember(file.path, content, hash);
			return { path: file.path, hash, size: content.byteLength, mtime: file.mtime };
		}));
	const hashed = await scan(context.runConcurrent(hashTasks, prepareConcurrency));
	const remoteFiles = await remoteRequest;
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
		if (remoteEntry?.rejected || (remoteEntry && remoteEntry.size > MAX_FILE_SIZE_BYTES)) {
			issues.push(remoteEntry.rejected ? rejectedSealedNoteIssue(path) : oversizedRemoteFileIssue(path));
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

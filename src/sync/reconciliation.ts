import type { FileDiff } from './types';
import type { FileEntry } from '../protocol/sync-types';
import { getPathEntry } from '../protocol/path-record';

/**
 * Classify one path using its local, remote, and last-common states.
 * This is the single policy boundary used by both full and incremental sync.
 */
export function classifyPath(
	path: string,
	local: FileEntry | undefined,
	remote: FileEntry | undefined,
	base: FileEntry | undefined,
): FileDiff | null {
	if (local && remote) {
		if (local.hash === remote.hash) return null;

		if (!base) {
			return {
				path,
				action: 'conflict',
				localHash: local.hash,
				remoteHash: remote.hash,
				cause: 'concurrent-create',
			};
		}

		const localChanged = local.hash !== base.hash;
		const remoteChanged = remote.hash !== base.hash;
		if (localChanged && remoteChanged) {
			return {
				path,
				action: 'conflict',
				localHash: local.hash,
				remoteHash: remote.hash,
				cause: 'concurrent-edit',
			};
		}
		if (localChanged) {
			return {
				path,
				action: 'upload',
				localHash: local.hash,
				remoteHash: remote.hash,
				cause: 'local-edited',
			};
		}
		return {
			path,
			action: 'download',
			localHash: local.hash,
			remoteHash: remote.hash,
			cause: 'remote-edited',
		};
	}

	if (local) {
		if (!base) {
			return { path, action: 'upload', localHash: local.hash, cause: 'local-created' };
		}
		if (local.hash === base.hash) {
			return { path, action: 'delete-local', localHash: local.hash, cause: 'remote-deleted' };
		}
		return { path, action: 'upload', localHash: local.hash, cause: 'remote-deleted' };
	}

	if (remote) {
		if (!base) {
			return { path, action: 'download', remoteHash: remote.hash, cause: 'remote-created' };
		}
		if (remote.hash === base.hash && base.revision && remote.revision === base.revision) {
			return { path, action: 'delete', remoteHash: remote.hash, remoteRevision: remote.revision, cause: 'local-deleted' };
		}
		return { path, action: 'download', remoteHash: remote.hash, cause: 'local-deleted' };
	}

	return null;
}

/**
 * Plan a three-way reconciliation from the local state, remote state, and their
 * last common manifest. Concurrent edit/delete pairs resolve in favor of the
 * edited content and are flagged so the user can review the outcome.
 */
export function classifyPaths(
	localFiles: Record<string, FileEntry>,
	remoteFiles: Record<string, FileEntry>,
	manifestEntries: Record<string, FileEntry>,
): FileDiff[] {
	const diffs: FileDiff[] = [];
	const allPaths = new Set([
		...Object.keys(localFiles),
		...Object.keys(remoteFiles),
		...Object.keys(manifestEntries),
	]);

	for (const path of allPaths) {
		const decision = classifyPath(
			path,
			getPathEntry(localFiles, path),
			getPathEntry(remoteFiles, path),
			getPathEntry(manifestEntries, path),
		);
		if (decision) diffs.push(decision);
	}

	return diffs;
}

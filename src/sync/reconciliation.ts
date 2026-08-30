import type { FileDiff, FileEntry } from '../plugin/types';

/**
 * Plan a three-way reconciliation from the local state, remote state, and their
 * last common manifest. Concurrent edit/delete pairs resolve in favor of the
 * edited content and are flagged so the user can review the outcome.
 */
export function detectConflicts(
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
		const local = localFiles[path];
		const remote = remoteFiles[path];
		const base = manifestEntries[path];

		if (local && remote) {
			if (local.hash === remote.hash) continue;

			if (!base || (local.hash !== base.hash && remote.hash !== base.hash)) {
				diffs.push({ path, action: 'conflict', localHash: local.hash, remoteHash: remote.hash });
			} else if (local.hash !== base.hash) {
				diffs.push({ path, action: 'upload', localHash: local.hash, remoteHash: remote.hash });
			} else {
				diffs.push({ path, action: 'download', localHash: local.hash, remoteHash: remote.hash });
			}
			continue;
		}

		if (local) {
			if (!base) {
				diffs.push({ path, action: 'upload', localHash: local.hash });
			} else if (local.hash === base.hash) {
				diffs.push({ path, action: 'delete-local', localHash: local.hash });
			} else {
				diffs.push({ path, action: 'upload', localHash: local.hash, conflict: true });
			}
			continue;
		}

		if (remote) {
			if (!base) {
				diffs.push({ path, action: 'download', remoteHash: remote.hash });
			} else if (remote.hash === base.hash) {
				diffs.push({ path, action: 'delete', remoteHash: remote.hash });
			} else {
				diffs.push({ path, action: 'download', remoteHash: remote.hash, conflict: true });
			}
		}
	}

	return diffs;
}

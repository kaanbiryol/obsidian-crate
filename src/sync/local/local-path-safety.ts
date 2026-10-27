import { Platform } from 'obsidian';
import { getPortablePathIssue, getSyncPathIssue } from '../../protocol/portable-path';
import type { SyncIssue } from '../types';

/** Validate before filesystem access, including reads and tombstone handling. */
export function assertLocalSyncPath(path: string): void {
	const unsafe = getSyncPathIssue(path);
	if (unsafe) throw new Error(`Invalid sync path: ${path} (${unsafe})`);
	const issue = unsupportedLocalPathIssue(path);
	if (issue) throw new Error(issue.message);
}

/** A valid sync path this device cannot store, such as `a:b.md` on Windows. Sync skips
 * such a remote file with this issue, like an oversized one, so it never fails a sync
 * or holds back the changelog cursor. */
export function unsupportedLocalPathIssue(path: string): SyncIssue | null {
	const issue = Platform.isWin ? getPortablePathIssue(path) : null;
	return issue ? { path, code: 'unsupported-device-path',
		message: `Cannot access ${path} on this Windows device: ${issue}. Rename it on the source device, then sync again.` } : null;
}

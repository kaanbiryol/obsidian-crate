import { Platform } from 'obsidian';
import { getPortablePathIssue, getSyncPathIssue } from '../protocol/portable-path';

/** Validate before filesystem access, including reads and tombstone handling. */
export function assertLocalSyncPath(path: string): void {
 const unsafe = getSyncPathIssue(path);
 if (unsafe) throw new Error(`Invalid sync path: ${path} (${unsafe})`);
 const issue = Platform.isWin ? getPortablePathIssue(path) : null;
 if (issue) throw new Error(`Cannot access ${path} on this Windows device: ${issue}. Rename it on the source device, then sync again.`);
}

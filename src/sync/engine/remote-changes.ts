import type { CheckResponse, FileEntry } from '../../protocol/sync-types';
import { unsupportedLocalPathIssue } from '../local/local-path-safety';
import { readIncrementalChangelog } from '../planner/incremental-changelog';

/** Where a check that found no remote changes stopped reading, and the saved cursor it read from. */
export interface RemoteChangesProgress {
	base: number;
	through: number;
}

interface RemoteChangesContext {
	lastSeq: number;
	/** Kept between checks, so this device's own uploads are read once, not on every check. */
	progress: RemoteChangesProgress | null;
	setProgress(progress: RemoteChangesProgress): void;
	checkForChanges(since: number): Promise<CheckResponse>;
	files: Parameters<typeof readIncrementalChangelog>[0];
	getBaseline(path: string): Readonly<FileEntry> | undefined;
	shouldIgnore(path: string): boolean;
	/** The largest file this device syncs with its server. */
	maxFileBytes(): number;
	signal: AbortSignal;
}

/** Whether a sync would bring server changes to this device. A sync saves the cursor it
 * read before uploading, so this device's own uploads also follow the cursor: entries
 * that match a local baseline, and paths this device skips, are not remote changes.
 * The changelog is read only when the cheap check reports entries after the cursor. A check
 * that finds none continues from where it stopped until a sync moves the saved cursor. */
export async function hasRemoteChanges(context: RemoteChangesContext): Promise<boolean> {
	// A device that never synced already shows "Not synced yet".
	if (context.lastSeq <= 0) return false;
	const since = context.progress?.base === context.lastSeq ? context.progress.through : context.lastSeq;
	const check = await context.checkForChanges(since);
	if (check.cursorExpired) return true;
	if (!check.hasChanges) return false;
	const changelog = await readIncrementalChangelog(context.files, since, () => context.signal.throwIfAborted());
	if (!changelog) return true;
	for (const [path, entry] of changelog.changesByPath) {
		if (context.shouldIgnore(path) || unsupportedLocalPathIssue(path)) continue;
		const baseline = context.getBaseline(path);
		if (entry.action === 'delete') {
			if (baseline) return true;
		} else if (entry.size <= context.maxFileBytes() && baseline?.hash !== entry.hash) {
			return true;
		}
	}
	context.setProgress({ base: context.lastSeq, through: changelog.latestSeq });
	return false;
}

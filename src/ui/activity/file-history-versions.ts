import type { RemoteFileVersion } from '../../protocol/sync-types';
import { MAX_PREVIEW_BYTES } from '../../protocol/sync-limits';
import { formatSize, parseServerTimestamp } from '../shared/format';

/** One row per storage key: a later row replaces an earlier one in its position. */
export function uniqueVersions(rows: readonly RemoteFileVersion[]): RemoteFileVersion[] {
	return [...new Map(rows.map(row => [row.storage_key, row])).values()];
}

/** The loaded versions and unfinished restores of `path`, newest first. */
export function versionRows(versions: readonly RemoteFileVersion[], pendingRestores: readonly RemoteFileVersion[], path: string): RemoteFileVersion[] {
	return uniqueVersions([...versions, ...pendingRestores]).filter(row => row.path === path)
		.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** The times the version list shows: every version, and the local file's last change when it exists. */
export function listedDates(rows: readonly RemoteFileVersion[], localModified?: number): Date[] {
	const dates = rows.map(row => parseServerTimestamp(row.created_at));
	if (localModified !== undefined) dates.push(new Date(localModified));
	return dates;
}

/** A time needs seconds when another listed time falls in the same minute. */
export function needsSeconds(date: Date, dates: readonly Date[]): boolean {
	const minute = Math.floor(date.getTime() / 60_000);
	return dates.filter(value => Math.floor(value.getTime() / 60_000) === minute).length > 1;
}

/** Why the version was kept, and its size. */
export function versionCaption(version: Pick<RemoteFileVersion, 'reason' | 'size'>): string {
	return `${version.reason === 'deleted' ? 'Before deletion' : 'Before update'} · ${formatSize(version.size)}`;
}

export function restoreActionLabel(pending: boolean): string {
	return pending ? 'Resume restore' : 'Restore this version';
}

/** Uses the "256 KB" wording of the server and history previews for the same limit. */
export const LOCAL_PREVIEW_LIMIT = `Preview is available for Markdown files up to ${MAX_PREVIEW_BYTES / 1000} KB. Select a saved version to compare or restore it.`;

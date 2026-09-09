import { isRecord } from '../plugin/settings';
import { assertPortablePaths, getPortablePathIssue } from './portable-path';
import { createPathRecord } from './path-record';
import type { FileEntry } from './sync-types';

export const isSyncHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const isSyncSequence = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// Reject control characters in all authoritative paths.
/* eslint-disable no-control-regex -- Protocol paths and revisions reject control characters. */
export function isSyncPath(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 1024
		&& !/[\u0000-\u001f\u007f\\]/.test(value)
		&& value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
		&& getPortablePathIssue(value) === null;
}

export function isSyncDate(value: unknown): value is string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
	const [year, month, day] = value.slice(0, 10).split('-').map(Number);
	return month! >= 1 && month! <= 12 && day! >= 1 && day! <= new Date(Date.UTC(year!, month, 0)).getUTCDate();
}

/** Revisions are opaque object identities. Legacy live objects used their path. */
export function isSyncRevision(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 1024
		&& !/[\u0000-\u001f\u007f\\]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
}

function parseSyncFileEntry(value: unknown, local = false): FileEntry {
	if (!isRecord(value) || !isSyncHash(value.hash) || !isSyncSequence(value.size)
		|| !(isSyncDate(value.modified) || local && value.modified === 'unverified')
		|| (value.revision !== undefined && !isSyncRevision(value.revision))
		|| (!local && !isSyncRevision(value.revision))) throw new Error('Invalid sync file metadata; no changes were applied');
	return { hash: value.hash, size: value.size, modified: value.modified,
		...(value.revision === undefined ? {} : { revision: value.revision }) };
}

export function parseSyncFiles(value: unknown, local = false): Record<string, FileEntry> {
	if (!isRecord(value)) throw new Error('Invalid sync file map; no changes were applied');
	const files = createPathRecord<FileEntry>();
	for (const [path, entry] of Object.entries(value)) {
		if (!isSyncPath(path)) throw new Error('Invalid sync path; no changes were applied');
		files[path] = parseSyncFileEntry(entry, local);
	}
	// A local checkpoint can include both old and new names while a rename settles.
	if (!local) assertPortablePaths(Object.keys(files));
	return files;
}

/* eslint-enable no-control-regex -- End of protocol control-character validation. */

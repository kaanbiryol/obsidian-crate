import { portablePathKey } from './portable-path';
import type { SyncIssueCode } from './sync-issues';
export const INITIAL_IMPORT_CAPABILITY = 'resumable-initial-import-v1';
// Initial imports omit the history/projection statements used by normal uploads.
// Leave room for authentication, staging and cleanup within D1's 50-query limit.
export const INITIAL_IMPORT_MAX_FILES = 32;
export interface InitialImport { token: string; state: 'importing' | 'complete' }

export const INITIAL_IMPORT_VERIFY_PAGE = 2000;
export type ImportInventoryEntry = [path: string, hash: string, size: number];

/** UTF-8 byte order: surrogate pairs encode code points above every BMP character. */
export function compareCodePoints(a: string, b: string): number {
	for (let index = 0; index < Math.min(a.length, b.length); index++) {
		const left = a.charCodeAt(index), right = b.charCodeAt(index);
		if (left === right) continue;
		const rank = (unit: number) => unit >= 0xe000 ? unit - 0x800 : unit >= 0xd800 ? unit + 0x2000 : unit;
		return rank(left) - rank(right);
	}
	return a.length - b.length;
}

/** Pages follow the server's primary key (portable path, binary collation), so
 * each completion request compares one bounded key range. */
export function importInventoryPages(files: Record<string, { hash: string; size: number }>): ImportInventoryEntry[][] {
	const entries = Object.keys(files).map(path => ({ key: portablePathKey(path), entry: [path, files[path]!.hash, files[path]!.size] as ImportInventoryEntry }))
		.sort((a, b) => compareCodePoints(a.key, b.key)).map(item => item.entry);
	const pages: ImportInventoryEntry[][] = [];
	for (let offset = 0; offset < entries.length; offset += INITIAL_IMPORT_VERIFY_PAGE) pages.push(entries.slice(offset, offset + INITIAL_IMPORT_VERIFY_PAGE));
	return pages.length ? pages : [[]];
}

export interface ReminderSetupProgress {
	scanning: boolean;
	remainingFiles: number;
	remainingSchedules: number;
}

export interface ReminderSetupStatus {
	ready: boolean;
	error?: string;
	progress?: ReminderSetupProgress;
	/** `code` and the one-based source `line` are additive; older servers send neither. */
	issues?: Array<{ path: string; message: string; code?: SyncIssueCode; line?: number }>;
	moreIssues?: boolean;
}

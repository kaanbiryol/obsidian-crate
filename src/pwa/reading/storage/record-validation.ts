import { isRecord } from '@/platform/validation';
import { validateReadingMetadata, type ReadingItem } from '@/reading/core/model';
import { isSyncPath } from '@/protocol/sync-validation';

/** Live responses and offline copies share the same item and article contract. */
export function isReadingItem(value: unknown, folder: string): value is ReadingItem {
	return parseReadingItem(value, folder) !== null;
}

function parseReadingItem(value: unknown, folder: string): ReadingItem | null {
	if (!isRecord(value) || typeof value.path !== 'string') return null;
	if (value.path && (!value.path.startsWith(`${folder}/`) || !isSyncPath(value.path))) return null;
	try { return { ...validateReadingMetadata(value), path: value.path }; } catch { return null; }
}

export interface ReadingListPage {
	items: ReadingItem[];
	issues: Array<{ path: string; message: string }>;
	cursor: string | null;
	/** The library revision the page answered for, to ask what changed since. */
	revision?: string;
}
const isRevision = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 64;
const isIssue = (issue: unknown): issue is ReadingListPage['issues'][number] => isRecord(issue) && typeof issue.path === 'string' && typeof issue.message === 'string';

/** What changed since a revision, or `reset` when the first page must be read again. */
export type ReadingChangesAnswer = { revision: string; reset: true } | { revision: string; reset?: undefined; items: ReadingItem[]; issues: ReadingListPage['issues']; removed: string[] };
export function parseReadingChanges(value: unknown, folder: string): ReadingChangesAnswer | null {
	if (!isRecord(value) || !isRevision(value.revision)) return null;
	if (value.reset === true) return { revision: value.revision, reset: true };
	if (!Array.isArray(value.items) || !Array.isArray(value.issues) || !Array.isArray(value.removed)
		|| !value.issues.every(isIssue) || !value.removed.every(path => typeof path === 'string')) return null;
	const items: ReadingItem[] = [];
	for (const valueItem of value.items) {
		const item = parseReadingItem(valueItem, folder);
		if (!item) return null;
		items.push(item);
	}
	return { revision: value.revision, items, issues: value.issues, removed: value.removed };
}

/** Reject a partial or malformed page before it enters the accumulated revision. */
export function parseReadingListPage(value: unknown, folder: string): ReadingListPage | null {
	if (!isRecord(value) || !Array.isArray(value.items) || !Array.isArray(value.issues)
		|| !(value.cursor === null || typeof value.cursor === 'string' && value.cursor.length > 0 && value.cursor.length <= 4096)) return null;
	if (!value.issues.every(isIssue) || value.revision !== undefined && !isRevision(value.revision)) return null;
	const items: ReadingItem[] = [];
	for (const valueItem of value.items) {
		const item = parseReadingItem(valueItem, folder);
		if (!item) return null;
		items.push(item);
	}
	return { items, issues: value.issues, cursor: value.cursor, ...isRevision(value.revision) ? { revision: value.revision } : {} };
}

export interface ReadingArticle { item: ReadingItem; markdown: string }
export function isReadingArticle(value: unknown, folder: string, expectedId?: string): value is ReadingArticle {
	return isRecord(value) && isReadingItem(value.item, folder) && typeof value.markdown === 'string'
		&& (expectedId === undefined || value.item.crate_reading_id === expectedId);
}

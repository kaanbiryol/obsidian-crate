import type { PendingReading, ReadingCommand } from '../outbox';
import { isRecord, isSha256Hex } from '@/platform/validation';
import { reminderOperationDay } from '@/protocol/reminder-operation';
import { readingHighlights } from '@/reading/core/highlights';
import { MAX_READING_TITLE_LENGTH, readingTimestamp, readingUrl } from '@/reading/core/model';
import { isReadingArticle, type ReadingArticle } from './record-validation';
import type { ReadingSession } from '../session/session';

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const nonNegativeNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function isReadingSession(value: unknown): value is ReadingSession {
	return isRecord(value) && nonEmptyString(value.token) && nonEmptyString(value.id)
		&& nonEmptyString(value.folderPath) && nonEmptyString(value.generation) && nonNegativeNumber(value.expiresAt);
}

/** `offline` marks a copy the user saved for offline reading. Copies without it were
 * stored automatically by earlier versions (`prefetched` ones in the background) and are
 * removed. `etag` is the server revision it came from, absent on copies saved before it was kept. */
export interface ReadingArticleCache extends ReadingArticle { usedAt: number; offline?: true; prefetched?: true; etag?: string }
export function isReadingArticleCache(value: unknown, folder: string): value is ReadingArticleCache {
	return isReadingArticle(value, folder) && 'usedAt' in value && nonNegativeNumber(value.usedAt)
		&& (!('offline' in value) || value.offline === true)
		&& (!('prefetched' in value) || value.prefetched === true)
		&& (!('etag' in value) || typeof value.etag === 'string' && value.etag.length <= 128);
}

export function isReadingDraft(value: unknown): value is { url: string } {
	// Drafts may contain incomplete URLs; validate their representation, not form validity.
	return isRecord(value) && typeof value.url === 'string';
}

function isChangeField(key: string, value: unknown, before: boolean): boolean {
	if (key === 'favorite') return typeof value === 'boolean';
	if (key === 'reading_status') return value === 'inbox' || value === 'archived';
	if (key === 'tags') return Array.isArray(value) && value.length <= 50
		&& value.every(tag => typeof tag === 'string' && !!tag.trim() && tag.length <= 100);
	if (key === 'highlights') {
		if (before && value === undefined) return true;
		try { readingHighlights(value); return true; } catch { return false; }
	}
	return false;
}

export function isReadingCommand(command: unknown): command is ReadingCommand {
	if (!isRecord(command) || !['capture', 'update', 'retry', 'delete'].includes(command.action as string)) return false;
	const { action, intent: value } = command;
	if (!isRecord(value) || 'operationId' in value) return false;
	if (action === 'capture') {
		try { readingUrl(value.url); } catch { return false; }
		return (value.title === undefined || typeof value.title === 'string' && value.title.length <= MAX_READING_TITLE_LENGTH)
			&& (value.fetchArticle === undefined || typeof value.fetchArticle === 'boolean');
	}
	if (!nonEmptyString(value.id)) return false;
	if (action === 'retry') return true;
	if (!isRecord(value.before)) return false;
	const before = value.before;
	if (action === 'delete') return isSha256Hex(value.markdownHash) && Object.keys(before).length > 0 && Object.entries(before).every(([key, field]) => isChangeField(key, field, true));
	if (!isRecord(value.changes)) return false;
	return Object.keys(value.changes).length > 0 && Object.entries(value.changes).every(([key, field]) =>
		isChangeField(key, field, false) && isChangeField(key, before[key], true));
}

function sameJson(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value: unknown, index) => sameJson(value, right[index]));
	if (!isRecord(left) || !isRecord(right)) return false;
	const leftKeys = Object.keys(left).filter(key => left[key] !== undefined);
	const rightKeys = Object.keys(right).filter(key => right[key] !== undefined);
	return leftKeys.length === rightKeys.length && leftKeys.every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

/** Validate in place. Dispatch bytes and unknown metadata are never rewritten. */
export function isPendingReading(value: unknown, sessionId: string): value is PendingReading {
	if (!isRecord(value) || !nonEmptyString(value.id) || value.sessionId !== sessionId) return false;
	if (value.error !== undefined && typeof value.error !== 'string'
		|| value.review !== undefined && typeof value.review !== 'boolean'
		|| value.attempts !== undefined && (!nonNegativeNumber(value.attempts) || !Number.isSafeInteger(value.attempts))
		|| value.retryAt !== undefined && !nonNegativeNumber(value.retryAt)) return false;
	if (value.queuedAt !== undefined) { try { readingTimestamp(value.queuedAt); } catch { return false; } }
	if (value.body !== undefined) {
		if (typeof value.body !== 'string') return false;
		let body: unknown;
		try { body = JSON.parse(value.body); } catch { return false; }
		if (!isRecord(body) || typeof body.operationId !== 'string' || reminderOperationDay(body.operationId) === null) return false;
		const { operationId: _operationId, ...intent } = body;
		if (!sameJson(intent, value.intent)) return false;
	}
	return isReadingCommand(value);
}

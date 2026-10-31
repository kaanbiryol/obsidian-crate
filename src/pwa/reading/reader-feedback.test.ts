import { describe, expect, it } from 'vitest';
import type { ReadingItem } from '@/reading/core/model';
import type { PendingReading } from './outbox';
import { pendingReadingHighlights, readingFailureFeedback, readingItemPending, readingItemSyncStatus, readingUpdateFeedback } from './reader-feedback';

const id = 'ab3b8ec4-dad3-44e4-8d29-0fbd026790ee', otherId = '3f0ef2a8-0d2f-4ad4-bb35-fd1a0f0e6a51';
const saved = { start: 0, end: 5, text: 'Hello' }, added = { start: 10, end: 15, text: 'world' };
const article: ReadingItem = {
	crate_reading_version: 1, crate_reading_id: id, title: 'A saved article', source_url: 'https://example.com/article',
	saved_at: '2026-09-23T00:00:00.000Z', reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'ready',
	path: 'Reading/article.md', highlights: [saved],
};
const update = (changes: Record<string, unknown>, extra: Partial<PendingReading> = {}, itemId = id): PendingReading =>
	({ id: crypto.randomUUID(), sessionId: 'session', action: 'update', intent: { id: itemId, changes, before: {} }, ...extra } as PendingReading);

describe('article sync status', () => {
	it('counts only the open article’s changes and its own pending capture', () => {
		const capture: PendingReading = { id, sessionId: 'session', action: 'capture', intent: { url: 'https://example.com/new' } };
		const other = update({ favorite: true }, {}, otherId);
		expect(readingItemPending([other, capture, update({ favorite: true })], id)).toHaveLength(2);
		expect(readingItemSyncStatus([other], id, false)).toEqual({ state: 'synced', label: 'All changes synced' });
		expect(readingItemSyncStatus([other, update({ favorite: true })], id, false)).toEqual({ state: 'syncing', label: 'Syncing 1 change' });
		expect(readingItemSyncStatus([update({ favorite: true })], id, true)).toEqual({ state: 'offline', label: 'Offline: 1 change waiting to sync' });
		expect(readingItemSyncStatus([update({ favorite: true }, { review: true, error: 'Rejected' })], id, false).state).toBe('error');
	});
	it('falls back to the article label while offline with nothing pending', () => {
		expect(readingItemSyncStatus([], id, true).state).toBe('synced');
	});
});

describe('pending highlights', () => {
	it('marks only passages the confirmed article does not have yet', () => {
		expect(pendingReadingHighlights(article, [update({ highlights: [saved, added] })])).toEqual([added]);
		expect(pendingReadingHighlights(article, [update({ highlights: [{ ...saved, note: 'Edited' }] })])).toEqual([]);
		expect(pendingReadingHighlights(article, [update({ favorite: true })])).toEqual([]);
		expect(pendingReadingHighlights(article, [update({ highlights: [saved, added] }, {}, otherId)])).toEqual([]);
	});
	it('turns solid once the change leaves the outbox or is rejected', () => {
		expect(pendingReadingHighlights({ ...article, highlights: [saved, added] }, [])).toEqual([]);
		expect(pendingReadingHighlights(article, [update({ highlights: [saved, added] }, { review: true })])).toEqual([]);
	});
});

describe('reader toast decisions', () => {
	it('confirms archive with Undo and keeps other successes silent', () => {
		expect(readingUpdateFeedback(article, { reading_status: 'archived' }, false)).toEqual({ kind: 'success', message: 'Archived', action: 'undo' });
		expect(readingUpdateFeedback(article, { reading_status: 'archived' }, true)).toEqual({ kind: 'success', message: 'Archived on this device', action: 'undo' });
		expect(readingUpdateFeedback({ ...article, reading_status: 'archived' }, { reading_status: 'inbox' }, false)).toBeNull();
		expect(readingUpdateFeedback(article, { favorite: true }, false)).toBeNull();
		expect(readingUpdateFeedback(article, { favorite: true }, true)).toBeNull();
		expect(readingUpdateFeedback(article, { highlights: [saved, added] }, false)).toBeNull();
	});
	it('announces only new offline passages, not notes or deletions', () => {
		expect(readingUpdateFeedback(article, { highlights: [saved, added] }, true)).toEqual({ kind: 'info', message: 'Highlight saved on this device' });
		expect(readingUpdateFeedback(article, { highlights: [{ ...saved, note: 'Note' }] }, true)).toBeNull();
		expect(readingUpdateFeedback(article, { highlights: [] }, true)).toBeNull();
	});
	it('names the failed change and offers Retry, or Review for a rejection', () => {
		expect(readingFailureFeedback(update({ highlights: [added] }, { error: 'Offline' }))).toEqual({ kind: 'error', message: 'Highlight didn’t sync', action: 'retry' });
		expect(readingFailureFeedback(update({ favorite: true }, { error: 'Failed' }))).toMatchObject({ message: 'Couldn’t favorite', action: 'retry' });
		expect(readingFailureFeedback(update({ reading_status: 'archived' }, { review: true }))).toMatchObject({ message: 'Couldn’t archive', action: 'review' });
		expect(readingFailureFeedback(update({ tags: ['a'] }, { error: 'Failed' })).message).toBe('Tags didn’t sync');
	});
});

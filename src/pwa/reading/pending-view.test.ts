import { describe, expect, it } from 'vitest';
import type { ReadingItem } from '@/reading/core/model';
import type { PendingReading } from './storage';
import { presentReadingItems } from './pending-view';

const article: ReadingItem = {
	crate_reading_version: 1,
	crate_reading_id: 'ab3b8ec4-dad3-44e4-8d29-0fbd026790ee',
	title: 'A saved article', source_url: 'https://example.com/article', saved_at: '2026-09-23T00:00:00.000Z',
	reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'ready', path: 'Reading/article.md',
};

describe('pending Reading presentation', () => {
	it('keeps a durable favorite visible over a stale server snapshot without mutating it', () => {
		const pending: PendingReading[] = [{
			id: 'operation', sessionId: 'session', action: 'update',
			intent: { id: article.crate_reading_id, changes: { favorite: true }, before: { favorite: false } },
		}];
		expect(presentReadingItems([article], pending)[0]?.favorite).toBe(true);
		expect(article.favorite).toBe(false);
		expect(presentReadingItems([article], [])[0]?.favorite).toBe(false);
	});

	it('ignores malformed stored changes instead of rendering them as article data', () => {
		const pending: PendingReading[] = [{ id: 'operation', sessionId: 'session', action: 'update',
			intent: { id: article.crate_reading_id, changes: { favorite: 'yes', tags: [42], reading_status: 'deleted' } } }];
		expect(presentReadingItems([article], pending)).toEqual([article]);
	});

	it('shows the confirmed value when a rejected change needs review', () => {
		const pending: PendingReading[] = [{ id: 'operation', sessionId: 'session', action: 'update', review: true,
			intent: { id: article.crate_reading_id, changes: { favorite: true } } }];
		expect(presentReadingItems([article], pending)[0]?.favorite).toBe(false);
	});
	it('shows locally saved links before confirmation, without duplicating known URLs', () => {
		const capture: PendingReading = { id: 'local-id', sessionId: 'session', action: 'capture', queuedAt: '2026-09-27T10:00:00.000Z',
			intent: { url: 'https://example.com/new#passage', title: 'New article' } };
		expect(presentReadingItems([], [capture])).toEqual([expect.objectContaining({ crate_reading_id: 'local-id', title: 'New article',
			source_url: 'https://example.com/new', saved_at: capture.queuedAt, extraction_status: 'pending', path: '' })]);
		expect(presentReadingItems([], [capture, { ...capture, id: 'duplicate' }])).toHaveLength(1);
		expect(presentReadingItems([article], [{ ...capture, intent: { url: article.source_url + '#passage' } }])).toEqual([article]);
		expect(presentReadingItems([], [{ ...capture, review: true }])).toEqual([]);
	});
	it('keeps uncertain edits visible and composes follow-ups in order', () => {
		const pending: PendingReading[] = [
			{ id: 'one', sessionId: 'session', action: 'update', body: 'sent', error: 'Reply lost', intent: { id: article.crate_reading_id, changes: { favorite: true, tags: ['essays'] } } },
			{ id: 'two', sessionId: 'session', action: 'update', intent: { id: article.crate_reading_id, changes: { favorite: false, reading_status: 'archived' } } },
		];
		expect(presentReadingItems([article], pending)[0]).toMatchObject({ favorite: false, tags: ['essays'], reading_status: 'archived' });
		expect(presentReadingItems([article], pending.map(op => ({ ...op, review: true })))).toEqual([article]);
	});
	it('shows extraction retry immediately and rolls it back if rejected', () => {
		const pending: PendingReading = { id: 'retry', sessionId: 'session', action: 'retry', intent: { id: article.crate_reading_id } };
		expect(presentReadingItems([article], [pending])[0]?.extraction_status).toBe('pending');
		expect(presentReadingItems([article], [{ ...pending, review: true }])[0]?.extraction_status).toBe('ready');
	});
});

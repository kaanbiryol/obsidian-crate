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
});

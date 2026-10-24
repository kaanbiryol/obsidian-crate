import { describe, expect, it } from 'vitest';
import { decideReminderListFailure, decideReminderListResponse, INVALID_REMINDER_LIST_MESSAGE, needsDiskFallback } from './reminder-list-response';
import type { CachedReminderSnapshot } from './types';

const record = (id: string, filePath: string) => ({ id, content: id, priority: 4 as const, completed: false, project: 'Inbox', filePath });
const confirmed = [record('a', 'Reminders/A.md')];
const context = { folderPath: 'Reminders', confirmed, lastCheckedAt: 10 };

describe('decideReminderListResponse', () => {
	it('keeps the confirmed list on 304 without reading a body', () => {
		expect(decideReminderListResponse({ status: 304, headers: new Headers({ ETag: '"live"' }), body: undefined }, context)).toEqual({ kind: 'not-modified' });
	});

	it('replaces a stale ETag and delta base with the response headers', () => {
		const body = { reminders: [record('b', 'Reminders/B.md')], projects: ['Inbox'], issues: [] };
		expect(decideReminderListResponse({ status: 200, headers: new Headers({ ETag: '"two"', 'X-Crate-Delta-Base': '9' }), body }, context))
			.toEqual({ kind: 'loaded', dropDeltaBase: false, result: body, etag: '"two"', deltaBase: '9' });
		expect(decideReminderListResponse({ status: 200, headers: new Headers(), body }, context))
			.toMatchObject({ kind: 'loaded', etag: undefined, deltaBase: undefined });
	});

	it('rejects an invalid body and shows the error state only before any confirmed read', () => {
		expect(decideReminderListResponse({ status: 200, headers: new Headers({ ETag: '"bad"' }), body: null }, context))
			.toEqual({ kind: 'invalid', dropDeltaBase: false, message: INVALID_REMINDER_LIST_MESSAGE, showErrorState: false });
		expect(decideReminderListResponse({ status: 200, headers: new Headers(), body: { reminders: 'nope' } }, { ...context, lastCheckedAt: null }))
			.toMatchObject({ kind: 'invalid', showErrorState: true });
	});

	it('drops the delta base for an invalid delta', () => {
		const body = { delta: true, changedPaths: ['Other/B.md'], reminders: [], projects: ['Inbox'], issues: [] };
		expect(decideReminderListResponse({ status: 200, headers: new Headers(), body }, { ...context, since: '7' }))
			.toMatchObject({ kind: 'invalid', dropDeltaBase: true });
	});
});

describe('decideReminderListFailure', () => {
	const cached: CachedReminderSnapshot = { folderPath: 'Reminders', reminders: confirmed, projects: ['Inbox'], savedAt: 5 };

	it('keeps a loaded snapshot and marks it stale on a network error', () => {
		expect(needsDiskFallback(10)).toBe(false);
		expect(decideReminderListFailure(new Error('offline'), { lastCheckedAt: 10 })).toEqual({ kind: 'keep-stale', message: 'offline' });
	});

	it('falls back to the disk copy on a first read', () => {
		expect(needsDiskFallback(null)).toBe(true);
		expect(decideReminderListFailure(new Error('offline'), { lastCheckedAt: null, cached })).toEqual({ kind: 'hydrate-cache', cached, message: 'offline' });
	});

	it('shows the error state when a first read has no disk copy', () => {
		expect(decideReminderListFailure('timeout', { lastCheckedAt: null, cached: null })).toEqual({ kind: 'error', message: 'timeout' });
	});
});

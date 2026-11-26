import { describe, expect, it } from 'vitest';
import { createReminderListCursor } from './reminder-list-cursor';
import { MAX_DELTA_CONFLICT_NOTES, REMINDER_IDENTITY_CONFLICT_ISSUE } from '@/reminders/core/reminder-list';

describe('reminder list cursor', () => {
	it('asks for a delta after a confirmed snapshot, naming its notes with duplicates', () => {
		const cursor = createReminderListCursor();
		expect(cursor.request('Reminders', [])).toMatchObject({ path: '/reminders/list?folderPath=Reminders', since: undefined });
		cursor.confirmed({ etag: '"one"', deltaBase: '42' }, 1);
		const request = cursor.request('My Reminders', []);
		expect(request.path).toBe('/reminders/list?folderPath=My%20Reminders&since=42');
		expect(request.headers.get('If-None-Match')).toBe('"one"');
		const issues = [{ path: 'My Reminders/A b.md', reason: REMINDER_IDENTITY_CONFLICT_ISSUE }, { path: 'My Reminders/Big.md', reason: 'Too large' }];
		expect(cursor.request('My Reminders', issues).path).toBe('/reminders/list?folderPath=My%20Reminders&since=42&conflict=My%20Reminders%2FA%20b.md');
		const many = Array.from({ length: MAX_DELTA_CONFLICT_NOTES + 1 }, (_, index) => ({ path: `My Reminders/${index}.md`, reason: REMINDER_IDENTITY_CONFLICT_ISSUE }));
		expect(cursor.request('My Reminders', many)).toMatchObject({ path: '/reminders/list?folderPath=My%20Reminders', since: undefined });
		// A long non-Latin name encodes to over 4,096 characters, so the URL stays short.
		const long = ['一', '二'].map(name => ({ path: `My Reminders/${name.repeat(500)}.md`, reason: REMINDER_IDENTITY_CONFLICT_ISSUE }));
		expect(cursor.request('My Reminders', long)).toMatchObject({ path: '/reminders/list?folderPath=My%20Reminders', since: undefined });
	});

	it('keeps the offline copy ETag when a 304 refreshes the live ETag', () => {
		const cursor = createReminderListCursor();
		cursor.hydrate({ etag: '"saved"', deltaBase: '1', savedAt: 10 });
		cursor.notModified(new Headers({ ETag: '"live"', 'X-Crate-Delta-Base': '2' }), 20);
		expect(cursor.persistedEtag).toBe('"saved"');
		expect(cursor.deltaBase).toBe('2');
		expect(cursor.request('Reminders', []).headers.get('If-None-Match')).toBe('"live"');
		expect(cursor.isFresh(15, 30)).toBe(true);
		expect(cursor.isFresh(5, 30)).toBe(false);
	});

	it('keeps the delta base when a confirmation omits it and forgets the server position on rebuild', () => {
		const cursor = createReminderListCursor();
		cursor.confirmed({ etag: '"one"', deltaBase: '7' }, 1);
		cursor.confirmed({ etag: '"two"' }, 2);
		expect(cursor.deltaBase).toBe('7');
		cursor.forgetServerPosition();
		expect(cursor).toMatchObject({ deltaBase: undefined, lastCheckedAt: null, persistedEtag: '"two"' });
		expect(cursor.request('Reminders', []).headers.has('If-None-Match')).toBe(false);
	});
});

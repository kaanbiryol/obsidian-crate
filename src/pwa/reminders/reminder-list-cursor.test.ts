import { describe, expect, it } from 'vitest';
import { createReminderListCursor } from './reminder-list-cursor';

describe('reminder list cursor', () => {
	it('asks for a delta only after a complete confirmed snapshot', () => {
		const cursor = createReminderListCursor();
		expect(cursor.request('Reminders', true)).toMatchObject({ path: '/reminders/list?folderPath=Reminders', since: undefined });
		cursor.confirmed({ etag: '"one"', deltaBase: '42' }, 1);
		const request = cursor.request('My Reminders', true);
		expect(request.path).toBe('/reminders/list?folderPath=My%20Reminders&since=42');
		expect(request.headers.get('If-None-Match')).toBe('"one"');
		expect(cursor.request('My Reminders', false).since).toBeUndefined();
	});

	it('keeps the offline copy ETag when a 304 refreshes the live ETag', () => {
		const cursor = createReminderListCursor();
		cursor.hydrate({ etag: '"saved"', deltaBase: '1', savedAt: 10 });
		cursor.notModified(new Headers({ ETag: '"live"', 'X-Crate-Delta-Base': '2' }), 20);
		expect(cursor.persistedEtag).toBe('"saved"');
		expect(cursor.deltaBase).toBe('2');
		expect(cursor.request('Reminders', true).headers.get('If-None-Match')).toBe('"live"');
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
		expect(cursor.request('Reminders', true).headers.has('If-None-Match')).toBe(false);
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	REMINDERS_CACHE_KEY,
	clearCachedReminderSnapshots,
	loadCachedReminderSnapshot,
	saveCachedReminderSnapshot,
} from './reminder-cache';
import type { ReminderRecord } from './types';

function memoryStorage(): Storage {
	const values = new Map<string, string>();
	return {
		get length() { return values.size; },
		clear: () => values.clear(),
		getItem: key => values.get(key) ?? null,
		key: index => Array.from(values.keys())[index] ?? null,
		removeItem: key => { values.delete(key); },
		setItem: (key, value) => { values.set(key, value); },
	};
}

const reminder: ReminderRecord = {
	id: 'r1',
	content: 'Cached task',
	priority: 4,
	completed: false,
	project: 'Inbox',
	filePath: 'Reminders/Inbox.md',
};

describe('PWA reminder cache fallback', () => {
	beforeEach(() => {
		vi.stubGlobal('localStorage', memoryStorage());
		vi.stubGlobal('indexedDB', undefined);
	});

	afterEach(() => vi.unstubAllGlobals());

	it('preserves snapshots and revisions when IndexedDB is unavailable', async () => {
		await saveCachedReminderSnapshot('Reminders', [reminder], ['Inbox'], 1234, '"revision"');

		await expect(loadCachedReminderSnapshot('Reminders')).resolves.toEqual({
			folderPath: 'Reminders',
			reminders: [reminder],
			projects: ['Inbox'],
			savedAt: 1234,
			etag: '"revision"',
		});
		await expect(loadCachedReminderSnapshot('Another folder')).resolves.toBeNull();
	});

	it('clears the fallback cache on logout', async () => {
		localStorage.setItem(REMINDERS_CACHE_KEY, JSON.stringify({
			folderPath: 'Reminders',
			reminders: [reminder],
			projects: ['Inbox'],
			savedAt: 1234,
		}));

		await clearCachedReminderSnapshots();

		expect(localStorage.getItem(REMINDERS_CACHE_KEY)).toBeNull();
	});
});

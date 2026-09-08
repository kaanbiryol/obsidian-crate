import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCachedReminderSnapshots, loadCachedReminderSnapshot, saveCachedReminderSnapshot } from './reminder-cache';
import type { ReminderRecord } from './types';

const reminder: ReminderRecord = {
	id: 'r1',
	content: 'Cached task',
	priority: 4,
	completed: false,
	project: 'Inbox',
	filePath: 'Reminders/Inbox.md',
};

describe('PWA reminder cache', () => {
	beforeEach(() => {
		vi.stubGlobal('indexedDB', undefined);
	});

	afterEach(() => vi.unstubAllGlobals());

	it('treats unavailable IndexedDB as an empty best-effort cache', async () => {
		await saveCachedReminderSnapshot('Reminders', [reminder], ['Inbox'], 1234, '"revision"');

		await expect(loadCachedReminderSnapshot('Reminders')).resolves.toBeNull();
	});

	it('reports that an unavailable cache could not be cleared', async () => {
		await expect(clearCachedReminderSnapshots()).resolves.toBe(false);
	});
});

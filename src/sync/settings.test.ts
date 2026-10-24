import { describe, expect, it } from 'vitest';
import { MAX_SYNC_HISTORY_PATHS, normalizeSyncHistory } from './settings';

describe('normalizeSyncHistory', () => {
	it('trims and dedupes valid entries and drops malformed ones', () => {
		expect(normalizeSyncHistory([
			{
				timestamp: ' 2026-01-01T00:00:00.000Z ',
				type: 'sync',
				success: true,
				uploaded: 1,
				downloaded: 2,
				deleted: 3,
				errorCount: 0,
				conflictCount: 0,
				uploadedPaths: [' notes/a.md ', 'notes/a.md'],
			},
			{ timestamp: '2026-01-01T00:00:00.000Z', type: 'invalid' },
		])).toEqual([
			{
				timestamp: '2026-01-01T00:00:00.000Z',
				type: 'sync',
				success: true,
				uploaded: 1,
				downloaded: 2,
				merged: 0,
				deleted: 3,
				errorCount: 0,
				conflictCount: 0,
				uploadedPaths: ['notes/a.md'],
			},
		]);
	});

	it('caps persisted sync history file lists to avoid oversized settings payloads', () => {
		const uploadedPaths = Array.from({ length: MAX_SYNC_HISTORY_PATHS + 10 }, (_, index) => `notes/${index}.md`);

		const history = normalizeSyncHistory([
			{
				timestamp: '2026-01-01T00:00:00.000Z',
				type: 'sync',
				success: true,
				uploaded: uploadedPaths.length,
				downloaded: 0,
				merged: 0,
				deleted: 0,
				errorCount: 0,
				conflictCount: 0,
				uploadedPaths,
			},
		]);

		expect(history[0]?.uploadedPaths).toHaveLength(MAX_SYNC_HISTORY_PATHS);
		expect(history[0]?.uploadedPaths?.[0]).toBe('notes/0.md');
		expect(history[0]?.uploadedPaths?.at(-1)).toBe(`notes/${MAX_SYNC_HISTORY_PATHS - 1}.md`);
	});
});

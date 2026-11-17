import { expect, it } from 'vitest';
import { formatShortSyncProgress, formatSyncProgress } from './progress-label';
it('shows recovery progress instead of an unrelated transfer counter', () => {
	expect(formatSyncProgress({ type: 'sync', current: 300, total: 8000 }, { phase: 'recovering', current: 16, total: 2000 }))
		.toBe('Recovering uploads: 16/2000');
});
it.each([
	['server', 'Checking for changes…'], ['scanning', 'Checking for changes…'],
	['saving', 'Saving sync progress…'], ['downloading', 'Downloading files…'],
] as const)('describes %s without stale counters', (phase, label) => {
	expect(formatSyncProgress({ type: 'sync', current: 0, total: 0 }, { phase })).toBe(label);
});
it('labels overall transfer progress as changes processed', () => {
	expect(formatSyncProgress({ type: 'sync', current: 5, total: 12 }, { phase: 'uploading' })).toBe('Uploading files… 5/12 changes processed');
});
it('shows upload-specific counts instead of overall counters', () => {
	expect(formatSyncProgress({ type: 'sync', current: 500, total: 500 }, { phase: 'uploading', current: 400, total: 500 }))
		.toBe('Uploading 400 of 500 files');
});
it('shows deletion-specific progress independently of completed uploads', () => {
	expect(formatSyncProgress({ type: 'sync', current: 36, total: 60 }, { phase: 'deleting', current: 4, total: 24 }))
		.toBe('Deleting 4 of 24 files');
});
it('names a single file in the singular', () => {
	expect(formatSyncProgress(null, { phase: 'deleting', current: 1, total: 1 })).toBe('Deleting 1 of 1 file');
});

it('shows remaining scheduling work without reusing upload counts', () => {
	expect(formatSyncProgress({ type: 'sync', current: 400, total: 400 }, {
		phase: 'reminders', reminderSetup: { scanning: false, remainingFiles: 0, remainingSchedules: 42 },
	})).toBe('Preparing reminder schedules: 42 remaining');
});

it('marks reminder setup counts that reached the server cap as a lower bound', () => {
	expect(formatSyncProgress(undefined, {
		phase: 'reminders', reminderSetup: { scanning: false, remainingFiles: 1000, remainingSchedules: 37 },
	})).toBe(`Preparing reminders: ${(1000).toLocaleString()}+ files and 37 schedules remaining`);
});

it.each([
	[{ phase: 'uploading', current: 12, total: 38 }, '12 / 38'],
	[{ phase: 'downloading', current: 1200, total: 3400 }, '1,200 / 3,400'],
	[{ phase: 'uploading' }, 'Uploading…'],
	[{ phase: 'reminders', reminderSetup: { scanning: false, remainingFiles: 9, remainingSchedules: 0 } }, 'Reminders…'],
	[{ phase: 'saving' }, 'Saving…'],
	[undefined, ''],
] as const)('keeps the Stop sync detail short for %j', (work, label) => {
	expect(formatShortSyncProgress(null, work)).toBe(label);
});

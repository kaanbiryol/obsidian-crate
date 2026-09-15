import { expect, it } from 'vitest';
import { formatSyncProgress } from './progress-label';
it('shows recovery progress instead of an unrelated transfer counter', () => {
  expect(formatSyncProgress({ type: 'sync', current: 300, total: 8000 }, { phase: 'recovering', current: 16, total: 2000 }))
    .toBe('Recovering interrupted uploads: 16/2000');
});
it('does not describe initial preparation counts as uploaded files', () => {
  expect(formatSyncProgress({ type: 'initial', current: 128, total: 8000 }, { phase: 'uploading' })).toBe('Uploading files…');
});
it.each([
  ['server', 'Loading server changes…'], ['scanning', 'Scanning and comparing vault files…'],
  ['saving', 'Saving sync progress…'], ['downloading', 'Downloading files…'],
] as const)('describes %s without stale counters', (phase, label) => {
  expect(formatSyncProgress({ type: 'sync', current: 0, total: 0 }, { phase })).toBe(label);
});
it('labels overall transfer progress as changes processed', () => {
  expect(formatSyncProgress({ type: 'sync', current: 5, total: 12 }, { phase: 'uploading' })).toBe('Uploading files… 5/12 changes processed');
});
it('shows upload-specific counts instead of preparation or overall counters', () => {
  expect(formatSyncProgress({ type: 'initial', current: 500, total: 500 }, { phase: 'uploading', current: 400, total: 500 }))
    .toBe('Uploading 400 of 500 files');
});

it('shows remaining scheduling work without reusing upload counts', () => {
  expect(formatSyncProgress({ type: 'initial', current: 400, total: 400 }, {
    phase: 'reminders', reminderSetup: { scanning: false, remainingFiles: 0, remainingSchedules: 42 },
  })).toBe('Preparing reminder schedules: 42 remaining');
});

import { expect, it } from 'vitest';
import { HttpError } from './api';
import { createAbortError } from './abort';
import { getSyncIssues, normalizeSyncIssues, recordSyncError, syncErrorIssues, withSyncFileContext } from './issues';
import { createEmptySyncResult, mergeSyncResults } from './sync-result';
import { recordSyncHistory } from './runtime-history';
import { normalizeCrateSettings } from '../plugin/settings';
import { DEFAULT_SETTINGS } from '../plugin/settings-types';

it('retains the innermost file context without changing authentication or retry exceptions', async () => {
  const error = new HttpError('Service unavailable', 503);
  await expect(withSyncFileContext(['one.md', 'two.md'], () =>
    withSyncFileContext('two.md', () => Promise.reject(error)))).rejects.toBe(error);
  expect(syncErrorIssues(error)).toEqual([{ path: 'two.md', message: error.message }]);
});

it('does not turn cancellation into a file failure', async () => {
  const error = createAbortError('cancelled');
  await expect(withSyncFileContext('note.md', () => Promise.reject(error))).rejects.toBe(error);
  expect(syncErrorIssues(error)).toEqual([{ message: 'cancelled' }]);
});

it('saves explicit file context through merged results and settings reload, without duplicating the legacy log', () => {
  const result = createEmptySyncResult();
  const transfer = createEmptySyncResult();
  recordSyncError(transfer, 'EACCES', 'Notes/café: <draft>.md');
  mergeSyncResults(result, transfer);
  result.success = false;
  const settings = { ...DEFAULT_SETTINGS, syncHistory: [] };
  recordSyncHistory(settings, 'sync', result);
  const reloaded = normalizeCrateSettings(settings, '.obsidian');
  expect(getSyncIssues(reloaded.syncHistory[0]!)).toEqual([{ path: 'Notes/café: <draft>.md', message: 'EACCES' }]);
  expect(getSyncIssues({ errors: ['note.md: old error'] })).toEqual([{ message: 'note.md: old error' }]);
});

it('bounds saved and remote issues and removes unsafe file paths without losing their explanation', () => {
  expect(normalizeSyncIssues([null, { message: '' }, { path: '../outside.md', message: 'unreadable', scope: 'reminders' },
    { path: 'Notes/a.md', message: 'x'.repeat(5000), scope: 'other' }])).toEqual([
    { message: 'unreadable', scope: 'reminders' }, { path: 'Notes/a.md', message: 'x'.repeat(4000) },
  ]);
  expect(normalizeSyncIssues(Array.from({ length: 60 }, () => ({ message: 'error' })))).toHaveLength(50);
});

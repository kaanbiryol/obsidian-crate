import { expect, it } from 'vitest';
import type { RemoteFileVersion } from '../../protocol/sync-types';
import { LOCAL_PREVIEW_LIMIT, listedDates, needsSeconds, restoreActionLabel, uniqueVersions, versionCaption, versionRows } from './file-history-versions';

const version = (storage_key: string, created_at: string, overrides: Partial<RemoteFileVersion> = {}): RemoteFileVersion => ({
	storage_key, created_at, path: 'Notes/plan.md', hash: 'a'.repeat(64), size: 2048, reason: 'replaced', expires_at: 0, ...overrides,
});

it('keeps one row per storage key, in first position with the latest copy', () => {
	const rows = uniqueVersions([version('a', '2026-09-01'), version('b', '2026-09-02'), version('a', '2026-09-01', { size: 1 })]);
	expect(rows.map(row => [row.storage_key, row.size])).toEqual([['a', 1], ['b', 2048]]);
});

it('lists the selected file\'s versions and unfinished restores once, newest first', () => {
	const pending = version('b', '2026-09-02', { revision: 'pending' });
	const rows = versionRows(
		[version('a', '2026-09-01'), version('b', '2026-09-02'), version('other', '2026-09-03', { path: 'Notes/other.md' })],
		[pending, version('c', '2026-09-04')], 'Notes/plan.md');
	expect(rows.map(row => row.storage_key)).toEqual(['c', 'b', 'a']);
	expect(rows[1]).toBe(pending);
});

it('shows seconds only for times that share a minute with another listed time', () => {
	const rows = [version('a', '2026-09-19 12:00:05'), version('b', '2026-09-19 12:00:45'), version('c', '2026-09-19 12:01:00')];
	const dates = listedDates(rows);
	expect(dates.map(date => needsSeconds(date, dates))).toEqual([true, true, false]);
	// The local file's last change counts too.
	const withLocal = listedDates(rows, Date.parse('2026-09-19T12:01:30Z'));
	expect(withLocal).toHaveLength(4);
	expect(needsSeconds(withLocal[2]!, withLocal)).toBe(true);
});

it('describes a version and its restore action', () => {
	expect(versionCaption(version('a', '2026-09-01', { reason: 'deleted' }))).toBe('Before deletion · 2.0 KiB');
	expect(versionCaption(version('a', '2026-09-01'))).toBe('Before update · 2.0 KiB');
	expect(restoreActionLabel(false)).toBe('Restore this version');
	expect(restoreActionLabel(true)).toBe('Resume restore');
});

it('states the local preview limit as the server does', () => {
	// Before: "250 KiB" for the same 256,000-byte limit the server calls "256 KB".
	expect(LOCAL_PREVIEW_LIMIT).toContain('up to 256 KB.');
});

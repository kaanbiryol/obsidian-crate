import { expect, it } from 'vitest';
import type { SyncActivityProgress, SyncState } from '../../sync/types';
import { describeActivityStatus } from './activity-status';

const now = Date.parse('2026-01-01T12:00:00Z');
const state: SyncState = { status: 'idle', lastSync: new Date(now).toISOString(), lastError: null, pendingChanges: 0, conflictCount: 0 };

it.each([
	['idle', 1, '1 change pending', 'pending'],
	['idle', 2, '2 changes pending', 'pending'],
	['idle', 0, 'Synced just now', 'synced'],
	['error', 1, 'Last sync had errors', 'attention'],
	['offline', 1, 'Server unavailable', 'attention'],
] as const)('describes %s with %i pending files', (status, pending, text, subtitleState) => {
	expect(describeActivityStatus({ ...state, status }, null, pending, true, false, now)).toMatchObject({ text, subtitleState });
});

it('keeps Stop sync enabled through completion work after the engine becomes idle', () => {
	const progress: SyncActivityProgress = { type: 'sync', current: 1, total: 1 };
	const busy = describeActivityStatus(state, progress, 1, true, false, now);
	expect(busy).toMatchObject({ text: 'Syncing…', indicatorState: { status: 'syncing' }, button: { label: 'Stop sync', disabled: false } });
	expect(describeActivityStatus(state, progress, 1, true, true, now).button).toMatchObject({ label: 'Stopping…', disabled: true });
	expect(describeActivityStatus(state, null, 0, true, false, now).button).toMatchObject({ label: 'Sync vault', disabled: false });
	expect(describeActivityStatus(state, progress, 1, false, false, now).button).toMatchObject({ label: 'Syncing…', disabled: true });
});

it.each(['server', 'scanning', 'preparing', 'uploading', 'downloading', 'applying', 'saving', 'reminders'] as const)(
	'keeps the header stable during %s and stops conflict checking after file transfer', phase => {
		const status = describeActivityStatus({ ...state, status: 'syncing', work: { phase } }, null, 1, true, false, now);
		expect(status).toMatchObject({ text: 'Syncing…', subtitleState: 'syncing', checkingConflicts: !['saving', 'reminders'].includes(phase) });
	},
);

it.each([[30_000, 'Synced just now'], [120_000, 'Synced 2m ago'], [7_200_000, 'Synced 2h ago'], [172_800_000, 'Synced 2d ago']] as const)(
	'formats a completed sync %i milliseconds ago', (elapsed, label) => {
		expect(describeActivityStatus({ ...state, lastSync: new Date(now - elapsed).toISOString() }, null, 0, true, false, now).lastSyncLabel).toBe(label);
	},
);

it('distinguishes initial upload progress from a vault that has never synced', () => {
	expect(describeActivityStatus({ ...state, lastSync: null }, null, 0, true, false, now).lastSyncLabel).toBe('Not synced yet');
	expect(describeActivityStatus(state, { type: 'initial', current: 0, total: 1 }, 0, true, false, now).lastSyncLabel).toBe('Uploading vault…');
});

import { describe, expect, it } from 'vitest';
import { initialReminderSyncState, reduceReminderSync, type ReminderSyncEvent, type ReminderSyncViewState } from './reminder-sync-state';
import type { ReminderRecord } from './types';

const record: ReminderRecord = { id: 'one', content: 'One', completed: false, priority: 4, revision: 'r1', filePath: 'Reminders/Inbox.md', project: 'Inbox' };
const snapshot = { reminders: [record], projects: ['Inbox'] };
const issue = { path: 'Reminders/Inbox.md', reason: 'Unreadable line' };
const run = (events: ReminderSyncEvent[], state: ReminderSyncViewState = initialReminderSyncState()) => events.reduce(reduceReminderSync, state);

describe('reminder sync view state', () => {
	it('starts loading an empty live list', () => {
		expect(initialReminderSyncState()).toEqual({ snapshot: { reminders: [], projects: [] }, loading: true, refreshing: false,
			indexingProgress: null, error: null, issues: [], dataMode: 'live', lastUpdatedAt: null, answered: false, hydratedAuthority: null });
	});

	it('shows a silent read as refreshing and a first read as loading, clearing error and progress', () => {
		const failed = run([{ type: 'read-settled' }, { type: 'error', message: 'Down' }, { type: 'indexing', progress: { indexedFiles: 1, totalFiles: 4 } }]);
		expect(run([{ type: 'read-started', silent: true }], failed)).toMatchObject({ loading: false, refreshing: true, error: null, indexingProgress: null });
		expect(run([{ type: 'read-started', silent: false }], failed)).toMatchObject({ loading: true, refreshing: false, error: null, indexingProgress: null });
	});

	it('hydrates the offline copy as cached, then confirms the server list as live and answered', () => {
		const hydrated = run([{ type: 'cache-hydrated', snapshot, issues: [issue], savedAt: 5 }]);
		expect(hydrated).toMatchObject({ loading: false, snapshot, issues: [issue], lastUpdatedAt: 5, dataMode: 'cached', answered: false });
		const unchanged = run([{ type: 'confirmed', savedAt: 9 }], hydrated);
		expect(unchanged).toMatchObject({ snapshot, lastUpdatedAt: 9, dataMode: 'live', answered: true });
		const next = { reminders: [], projects: [] };
		expect(run([{ type: 'list-received', issues: [] }, { type: 'confirmed', snapshot: next, savedAt: 10 }], unchanged))
			.toMatchObject({ snapshot: next, issues: [], error: null, lastUpdatedAt: 10 });
		expect(run([{ type: 'connectivity-changed' }], unchanged).answered).toBe(false);
	});

	it('shows unavailable data only for a rejected first list', () => {
		const loaded = run([{ type: 'confirmed', snapshot, savedAt: 1 }]);
		expect(run([{ type: 'list-rejected', message: 'Invalid', showErrorState: false }], loaded)).toMatchObject({ error: 'Invalid', dataMode: 'live' });
		expect(run([{ type: 'list-rejected', message: 'Invalid', showErrorState: true }])).toMatchObject({ error: 'Invalid', dataMode: 'error' });
	});

	it.each([
		['keep-stale', 'cached'],
		['error', 'error'],
	] as const)('marks a %s failure as %s data', (outcome, dataMode) => {
		expect(run([{ type: 'read-failed', outcome, message: 'Offline' }])).toMatchObject({ error: 'Offline', dataMode });
	});

	it('keeps the cached mode that a disk fallback hydrated', () => {
		const state = run([
			{ type: 'cache-hydrated', snapshot, issues: [], savedAt: 3 },
			{ type: 'read-failed', outcome: 'hydrate-cache', message: 'Offline' },
			{ type: 'read-settled' },
		]);
		expect(state).toMatchObject({ snapshot, dataMode: 'cached', error: 'Offline', loading: false, refreshing: false });
	});

	it('resets the list but keeps the error, mode, answer and hydrated connection', () => {
		const authority = {};
		const empty = { reminders: [], projects: [] };
		const state = run([
			{ type: 'confirmed', snapshot, savedAt: 1 }, { type: 'list-received', issues: [issue] },
			{ type: 'read-started', silent: true }, { type: 'error', message: 'Later failure' }, { type: 'hydration-finished', authority },
			{ type: 'reset', snapshot: empty },
		]);
		expect(state).toEqual({ snapshot: empty, loading: false, refreshing: false, indexingProgress: null, error: 'Later failure', issues: [],
			dataMode: 'live', lastUpdatedAt: null, answered: true, hydratedAuthority: authority });
	});

	it('returns the same state when an event changes nothing', () => {
		const idle = run([{ type: 'read-settled' }]);
		for (const event of [{ type: 'read-settled' }, { type: 'reads-detached' }, { type: 'error', message: null }, { type: 'connectivity-changed' }] as const) {
			expect(reduceReminderSync(idle, event)).toBe(idle);
		}
		const progress = { indexedFiles: 2, totalFiles: 4 };
		const indexing = run([{ type: 'indexing', progress }], idle);
		expect(run([{ type: 'reads-detached' }], indexing)).toEqual(idle);
	});
});

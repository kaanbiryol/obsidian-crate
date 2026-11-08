import { expect, it } from 'vitest';
import { readingFeatureStatus } from './reading-status';
import { reminderFeatureStatus } from './reminder-status';

const synced = { state: 'synced' as const, label: 'All changes synced' };
const failed = { state: 'error' as const, label: 'Sync needs attention: refresh Reading' };
const base = { enabled: true, syncStatus: synced, pendingCount: 0, recovery: false, error: null, disabled: false };

it('reports sync progress while enabled and saved work while paused, worded like Reminders', () => {
	expect(readingFeatureStatus(base)).toEqual({ status: synced, attention: null, unsynced: false });
	const paused = readingFeatureStatus({ ...base, enabled: false, pendingCount: 2 });
	expect(paused).toEqual({ status: { state: 'cached', label: 'Paused: 2 changes saved on this device' }, attention: null, unsynced: true });
	expect(paused.status).toEqual(reminderFeatureStatus({ enabled: false, syncStatus: synced, pendingCount: 2, needsRecovery: false, storageError: null }).status);
	expect(readingFeatureStatus({ ...base, enabled: false, pendingCount: 1 }).status.label).toBe('Paused: 1 change saved on this device');
	expect(readingFeatureStatus({ ...base, enabled: false, recovery: true }).status).toEqual({ state: 'error', label: 'Paused' });
});

it('asks for attention with the error, unless the server has Reading turned off', () => {
	expect(readingFeatureStatus({ ...base, syncStatus: failed, error: 'Reading request failed.' }))
		.toEqual({ status: failed, attention: 'Reading request failed.', unsynced: true });
	expect(readingFeatureStatus({ ...base, syncStatus: failed }).attention).toBe(failed.label);
	expect(readingFeatureStatus({ ...base, syncStatus: failed, error: 'Reading is paused.', disabled: true }))
		.toEqual({ status: failed, attention: null, unsynced: false });
	expect(readingFeatureStatus({ ...base, recovery: true }).unsynced).toBe(true);
});

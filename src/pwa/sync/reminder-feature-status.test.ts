import { expect, it } from 'vitest';
import { reminderFeatureStatus } from './reminder-status';

const synced = { state: 'synced' as const, label: 'All changes synced' };

it('reports sync progress while enabled and saved work while paused', () => {
	expect(reminderFeatureStatus({ enabled: true, syncStatus: synced, pendingCount: 0, needsRecovery: false, storageError: null }))
		.toEqual({ status: synced, attention: null, unsynced: false });
	expect(reminderFeatureStatus({ enabled: false, syncStatus: synced, pendingCount: 2, needsRecovery: false, storageError: null }))
		.toEqual({ status: { state: 'cached', label: 'Paused: 2 changes saved on this device' }, attention: null, unsynced: true });
});

it('asks for review when saved changes need recovery', () => {
	expect(reminderFeatureStatus({ enabled: false, syncStatus: synced, pendingCount: 0, needsRecovery: true, storageError: null }))
		.toEqual({ status: { state: 'error', label: 'Paused' }, attention: 'Saved reminder changes need review.', unsynced: true });
	expect(reminderFeatureStatus({ enabled: true, syncStatus: { state: 'error', label: 'Sync needs attention' }, pendingCount: 1, needsRecovery: false, storageError: null }).attention)
		.toBe('Sync needs attention');
});

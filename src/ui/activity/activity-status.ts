import type { SyncActivityProgress, SyncState } from '../../sync/types';
import { formatTimeAgo } from '../shared/format';
import { formatSyncProgress } from './progress-label';

type SyncStatusKind = 'syncing' | 'error' | 'offline' | 'checking' | 'pending' | 'synced' | 'never';

function lastSyncStatus(state: SyncState, syncing: boolean, now: number): { kind: SyncStatusKind; text: string } {
	if (syncing) return { kind: 'syncing', text: 'Syncing…' };
	if (state.status === 'error') return { kind: 'error', text: 'Last sync had errors' };
	if (state.status === 'offline') return { kind: 'offline', text: 'Server unavailable' };
	if (state.initializing) return { kind: 'checking', text: 'Checking local files…' };
	if (!state.lastSync) return { kind: 'never', text: 'Not synced yet' };
	return { kind: 'synced', text: `Synced ${formatTimeAgo(new Date(state.lastSync).getTime(), now)}` };
}

/** One phrase per sync state, shared by Sync activity and the status bar. */
export function describeSyncStatus(state: SyncState, pending: number, syncing = state.status === 'syncing', now = Date.now()) {
	const lastSync = lastSyncStatus(state, syncing, now);
	const status = pending > 0 && (lastSync.kind === 'synced' || lastSync.kind === 'never')
		? { kind: 'pending' as const, text: `${pending} ${pending === 1 ? 'change' : 'changes'} pending` }
		: lastSync;
	return { ...status, lastSyncLabel: lastSync.text };
}

/** Whether a sync or startup check is running, so Sync activity shows progress instead of
 * pending files. `progress` is set through completion work after the engine becomes idle. */
export function isActivityBusy(state: SyncState, progress: SyncActivityProgress | null): boolean {
	return state.status === 'syncing' || !!progress || !!state.initializing && state.status === 'idle';
}

export function describeActivityStatus(
	state: SyncState,
	progress: SyncActivityProgress | null,
	pending: number,
	canStopSync: boolean,
	stopping: boolean,
	now = Date.now(),
) {
	const syncing = state.status === 'syncing' || !!progress;
	const status = describeSyncStatus(state, pending, syncing, now);
	// The header names what the running sync is doing; the button below keeps a short form.
	const work = state.work ?? progress?.work;
	const text = syncing && work ? formatSyncProgress(progress, work) : status.text;
	const needsAttention = state.status === 'error' || state.status === 'offline';
	const checking = !!state.initializing && !syncing && !needsAttention;
	const canStop = syncing && canStopSync;
	const buttonLabel = stopping ? 'Stopping…' : canStop ? 'Stop sync' : syncing ? 'Syncing…' : checking ? 'Checking…' : 'Sync';
	return {
		lastSyncLabel: status.lastSyncLabel,
		text,
		subtitleState: syncing || checking ? 'syncing' : needsAttention ? 'attention' : status.kind === 'pending' ? 'pending' : status.kind === 'synced' ? 'synced' : 'idle',
		indicatorState: syncing ? { ...state, status: 'syncing' as const } : state,
		checkingConflicts: checking || syncing && !['saving', 'reminders'].includes(state.work?.phase ?? ''),
		/** The Pending tab's sync button. While `idle` it starts a sync, and the file list names
		 * what that sync uploads; otherwise it stops the running sync or waits. */
		button: {
			label: buttonLabel,
			disabled: stopping || checking || (syncing && !canStop),
			idle: !stopping && !syncing && !checking,
		},
	};
}

/** The idle sync button's label and description for `checked` of `total` pending files.
 * Every sync gets remote changes; unchecked files stay on this device. */
export function describeSyncSelection(checked: number, total: number): { label: string; title: string } {
	if (total === 0) return { label: 'Sync', title: 'Get changes from your other devices.' };
	if (checked === 0) return { label: 'Get remote changes', title: 'Get changes from your other devices. Unchecked files stay on this device.' };
	const label = `Sync ${checked} ${checked === 1 ? 'file' : 'files'}`;
	return checked < total
		? { label, title: 'Upload the checked files and get changes from your other devices. Unchecked files stay on this device.' }
		: { label, title: 'Upload these files and get changes from your other devices.' };
}

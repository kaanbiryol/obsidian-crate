import type { SyncActivityProgress, SyncState } from '../../sync/types';

function lastSyncLabel(state: SyncState, progress: SyncActivityProgress | null, now: number): string {
	if (progress?.type === 'initial') return 'Uploading vault…';
	if (state.status === 'syncing' || progress) return 'Syncing…';
	if (state.status === 'error') return 'Last sync had errors';
	if (state.status === 'offline') return 'Server unavailable';
	if (!state.lastSync) return 'Not synced yet';
	const minutes = Math.floor((now - new Date(state.lastSync).getTime()) / 60_000);
	if (minutes < 1) return 'Synced just now';
	if (minutes < 60) return `Synced ${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `Synced ${hours}h ago` : `Synced ${Math.floor(hours / 24)}d ago`;
}

export function describeActivityStatus(
	state: SyncState,
	progress: SyncActivityProgress | null,
	pending: number,
	canStopSync: boolean,
	stopping: boolean,
	now = Date.now(),
) {
	const label = lastSyncLabel(state, progress, now);
	const syncing = state.status === 'syncing' || !!progress;
	const needsAttention = state.status === 'error' || state.status === 'offline';
	const text = syncing ? 'Syncing…' : needsAttention ? label
		: pending > 0 ? `${pending} ${pending === 1 ? 'change' : 'changes'} pending` : label;
	const canStop = syncing && canStopSync;
	const buttonLabel = stopping ? 'Stopping…' : canStop ? 'Stop sync' : syncing ? 'Syncing…' : 'Sync vault';
	return {
		lastSyncLabel: label,
		text,
		subtitleState: syncing ? 'syncing' : needsAttention ? 'attention' : pending > 0 ? 'pending' : label.startsWith('Synced') ? 'synced' : 'idle',
		indicatorState: syncing ? { ...state, status: 'syncing' as const } : state,
		checkingConflicts: syncing && !['saving', 'reminders'].includes(state.work?.phase ?? ''),
		button: {
			label: buttonLabel,
			disabled: stopping || (syncing && !canStop),
			title: buttonLabel === 'Sync vault' ? 'Sync all local and remote changes, including unchecked files.' : buttonLabel,
		},
	};
}

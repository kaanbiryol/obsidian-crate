import type { SyncActivityProgress, SyncState } from '../../sync/types';
import { formatTimeAgo } from '../shared/format';

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
	const needsAttention = state.status === 'error' || state.status === 'offline';
	const checking = !!state.initializing && !syncing && !needsAttention;
	const canStop = syncing && canStopSync;
	const buttonLabel = stopping ? 'Stopping…' : canStop ? 'Stop sync' : syncing ? 'Syncing…' : checking ? 'Checking…' : 'Sync vault';
	return {
		lastSyncLabel: status.lastSyncLabel,
		text: status.text,
		subtitleState: syncing || checking ? 'syncing' : needsAttention ? 'attention' : status.kind === 'pending' ? 'pending' : status.kind === 'synced' ? 'synced' : 'idle',
		indicatorState: syncing ? { ...state, status: 'syncing' as const } : state,
		checkingConflicts: checking || syncing && !['saving', 'reminders'].includes(state.work?.phase ?? ''),
		button: {
			label: buttonLabel,
			disabled: stopping || checking || (syncing && !canStop),
			title: buttonLabel === 'Sync vault' ? 'Sync all local and remote changes, including unchecked files.' : buttonLabel,
		},
	};
}

import type { SettingsSnapshot } from '../settings-store';
import type { SyncIndicatorState } from '@/ui/shared/SyncIndicator';

/** Readiness is about durable data, including paused features, never screen mounting. */
export function pwaSyncState(snapshot: Pick<SettingsSnapshot, 'reading' | 'reminders'>) {
	const entries = [ ['reminders', snapshot.reminders], ['reading', snapshot.reading] ] as const;
	const models = entries.flatMap(([, model]) => model ? [model] : []);
	const ready = models.length === 2 && models.every(model => model.ready);
	const pendingCount = models.reduce((sum, model) => sum + (model.pendingCount ?? 0), 0);
	const unsynced = !ready || models.some(model => model.unsynced);
	const canUpdate = ready && !unsynced && models.every(model => model.updateReady === true && model.canApplyUpdate?.() === true);
	const nextRetryAt = Math.min(...models.map(model => model.retryAt ?? Infinity));
	const named = (feature: string, label: string) => `${feature === 'reading' ? 'Reading' : 'Reminders'}: ${label}`;
	let status: { state: SyncIndicatorState; label: string };
	const attention = entries.find(([, model]) => model?.attention);
	const failure = entries.find(([, model]) => model?.enabled !== false && model?.connected && model.status.state === 'error');
	const pausedWork = entries.find(([, model]) => model?.enabled === false && model.unsynced);
	const active = models.filter(model => model.enabled !== false && model.connected);
	if (attention?.[1]) status = { state: 'error', label: named(attention[0], attention[1].attention!) };
	else if (failure?.[1]) status = { state: 'error', label: named(failure[0], failure[1].status.label) };
	else if (!ready) status = { state: 'syncing', label: 'Checking saved changes…' };
	else if (pausedWork?.[1]) status = { state: 'cached', label: named(pausedWork[0], pausedWork[1].status.label) };
	else if (active.some(model => model.status.state === 'offline')) status = { state: 'offline', label: pendingCount ? `Offline: ${pendingCount} ${pendingCount === 1 ? 'change' : 'changes'} waiting to sync` : 'Offline: showing saved data' };
	else if (active.some(model => model.status.state === 'syncing')) status = { state: 'syncing', label: pendingCount ? `Syncing ${pendingCount} ${pendingCount === 1 ? 'change' : 'changes'}` : 'Refreshing Crate' };
	else if (active.some(model => model.status.state === 'cached') || unsynced) status = { state: 'cached', label: 'Saved changes are waiting to sync' };
	else if (active.length) status = { state: 'synced', label: 'All changes synced' };
	else status = { state: 'cached', label: models.some(model => model.enabled === false) ? 'Sync paused' : 'Not connected' };
	return { ready, unsynced, canUpdate, pendingCount, nextRetryAt, status };
}

/** A failed feature does not prevent the other feature's refresh from completing. */
export async function refreshPwaSync(snapshot: Pick<SettingsSnapshot, 'reading' | 'reminders'>) {
	const results = await Promise.allSettled([snapshot.reading, snapshot.reminders]
		.filter(model => model?.enabled !== false && model?.ready)
		.map(model => Promise.resolve().then(() => model!.onRefresh())));
	const failed = results.find(result => result.status === 'rejected');
	if (failed?.status === 'rejected') throw failed.reason;
}

/** Start revocation with captured credentials, then immediately clear both private views. */
export async function logoutPwaSync(snapshot: Pick<SettingsSnapshot, 'reading' | 'reminders'>) {
	const model = snapshot.reminders?.connected ? snapshot.reminders : snapshot.reading ?? snapshot.reminders;
	if (!model) throw new Error('Settings are still loading.');
	const completion = model.onLogout();
	snapshot.reminders?.clearView?.();
	snapshot.reading?.clearView?.();
	await completion;
}

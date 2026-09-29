import type { ReadingChanges } from '@/reading/core/model';
import type { PendingReading, ReadingUpdateIntent } from './outbox';

/** Only an undispatched update may change; dispatched bytes belong to a receipt. */
export function coalesceReadingUpdate(op: PendingReading, intent: Pick<ReadingUpdateIntent, 'changes' | 'before'>): boolean {
	if (op.action !== 'update' || op.body !== undefined || op.review) return false;
	const changes = intent.changes;
	if (!changes || !Object.keys(changes).length) return false;
	const previous = op.intent.changes;
	const oldBefore = op.intent.before;
	const newBefore = intent.before;
	// A peer tab's stale view must not replace newer local edits.
	assertReadingUpdateBase([op], intent);
	const merged = { ...previous, ...changes };
	op.intent = { ...op.intent, changes: merged,
		before: Object.fromEntries((Object.keys(merged) as (keyof ReadingChanges)[]).map(key => [key, key in previous ? oldBefore[key] : newBefore[key]])) };
	return true;
}

/** Follow-up edits must start from the latest local value of every changed field. */
export function assertReadingUpdateBase(pending: PendingReading[], intent: Pick<ReadingUpdateIntent, 'changes' | 'before'>): void {
	const changes = intent.changes;
	const before = intent.before;
	const latest = pending.reduce<ReadingChanges>((changes, op) => op.action === 'update' ? { ...changes, ...op.intent.changes } : changes, {});
	for (const key of (Object.keys(changes) as (keyof ReadingChanges)[])) {
		if (key in latest && JSON.stringify(latest[key]) !== JSON.stringify(before[key])) {
			throw new Error('This article changed in another tab. Reopen it before editing.');
		}
	}
}

import type { PendingReading } from './storage';

/** Only an undispatched update may change; dispatched bytes belong to a receipt. */
export function coalesceReadingUpdate(op: PendingReading, intent: Record<string, unknown>): boolean {
	if (op.action !== 'update' || op.body !== undefined || op.review) return false;
	const changes = intent.changes as Record<string, unknown> | undefined;
	if (!changes || !Object.keys(changes).length) return false;
	const previous = op.intent.changes as Record<string, unknown>;
	const oldBefore = op.intent.before as Record<string, unknown>;
	const newBefore = intent.before as Record<string, unknown>;
	// A peer tab's stale view must not replace newer local edits.
	assertReadingUpdateBase([op], intent);
	const merged = { ...previous, ...changes };
	op.intent = { ...op.intent, changes: merged,
		before: Object.fromEntries(Object.keys(merged).map(key => [key, key in previous ? oldBefore[key] : newBefore[key]])) };
	return true;
}

/** Follow-up edits must start from the latest local value of every changed field. */
export function assertReadingUpdateBase(pending: PendingReading[], intent: Record<string, unknown>): void {
	const changes = intent.changes as Record<string, unknown>;
	const before = intent.before as Record<string, unknown>;
	const latest = Object.assign({}, ...pending.filter(op => op.action === 'update').map(op => op.intent.changes)) as Record<string, unknown>;
	for (const key of Object.keys(changes)) {
		if (key in latest && JSON.stringify(latest[key]) !== JSON.stringify(before[key])) {
			throw new Error('This article changed in another tab. Reopen it before editing.');
		}
	}
}

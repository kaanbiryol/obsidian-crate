import type { PendingReading } from './storage';

/** Only an undispatched update may change; dispatched bytes belong to a receipt. */
export function coalesceReadingHighlights(op: PendingReading, intent: Record<string, unknown>): boolean {
	if (op.action !== 'update' || op.body !== undefined || op.review) return false;
	const changes = intent.changes as Record<string, unknown> | undefined;
	if (!changes || Object.keys(changes).some(key => key !== 'highlights') || !('highlights' in changes)) return false;
	const previous = op.intent.changes as Record<string, unknown>;
	const oldBefore = op.intent.before as Record<string, unknown>;
	const newBefore = intent.before as Record<string, unknown>;
	// A peer tab's stale selection must not replace newer local annotations.
	if ('highlights' in previous && JSON.stringify(previous.highlights) !== JSON.stringify(newBefore.highlights)) throw new Error('Highlights changed in another tab. Reopen this article before editing.');
	const merged = { ...previous, ...changes };
	op.intent = { ...op.intent, changes: merged,
		before: Object.fromEntries(Object.keys(merged).map(key => [key, key in previous ? oldBefore[key] : newBefore[key]])) };
	return true;
}
